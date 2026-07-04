/**
 * MiningModal — Migaku-style sentence-miner.
 *
 * Opened by `window.dispatchEvent(new CustomEvent('tokori-open-miner',
 * { detail: { sentence?, word?, lang?, sourceUrl? } }))`. The YT
 * overlay's ⛏ button fires it with no detail (the modal then reads
 * the live MiningSource); the HoverPopup's "Mine card" button passes
 * the selected word + extracted sentence + detected language so the
 * cloze target is pre-selected.
 *
 * Why a separate modal from the SentenceAnalyzer:
 *   - Analyzer is read-only — explain a line.
 *   - Miner is write-flow — produce a card. Different surface, different
 *     state machine (image capture, clip recording, multi-target save).
 *   - Reuses the analyzer's `tokenise()` + `TokenTranslation` so the
 *     sentence-with-tokens UI feels identical.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { TOKENS, s } from '../lib/theme';
import { getLanguage, type LanguageCode } from '../lib/languages';
import type { DictEntry } from '../lib/dictionaries/idb';
import type { SaveTargets, Settings } from '../lib/settings';
import { getMiningSource, type MiningSource } from '../lib/mining/source';
import {
  captureVideoFrame,
  recordVideoClip,
  type FrameCapture,
  type ClipCapture,
} from '../lib/mining/capture';
import { tokenise } from './sentence-tokens';
import { markSentence, setTabSaveTargets } from './mining-helpers';
import { warn } from '../lib/log';

export interface MinerOpenDetail {
  /** Pre-selected studied word (cloze target). Optional — the user can
   *  click a token in the modal to set it. */
  word?: string;
  /** Pre-filled sentence. Optional — when opened from the YT toolbar
   *  we fetch the active cue from `getMiningSource()` instead. */
  sentence?: string;
  /** Display / dictionary language. */
  lang?: LanguageCode | null;
  /** Caller-provided source URL. Falls back to the MiningSource's URL
   *  or `window.location.href`. */
  sourceUrl?: string;
}

export function MiningModal({ detail, onClose }: { detail: MinerOpenDetail; onClose: () => void }) {
  // ── Source resolution ───────────────────────────────────────────
  // Snapshot the MiningSource on mount — if the user has the YT
  // enhancer open, we get the active cue + <video>; otherwise (popup
  // path on a generic page) we work with the caller's `detail` only
  // and skip media capture.
  const sourceRef = useRef<MiningSource | null>(getMiningSource());
  const source = sourceRef.current;
  const initialSentence = (detail.sentence?.trim() || source?.currentCue?.text || '').trim();
  const initialLang = (detail.lang as LanguageCode | undefined) || source?.currentCue?.lang || null;
  const initialTranslation = source?.currentTranslatedCue?.text || '';
  const sourceUrl = detail.sourceUrl || source?.sourceUrl || window.location.href;

  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    sendMsg({ action: 'getSettings' }, (res) => {
      if (res?.success) {
        const data = (res as unknown as { data?: Settings }).data;
        if (data) setSettings(data);
      }
    });
  }, []);

  const [sentence, setSentence] = useState(initialSentence);
  const [lang] = useState<LanguageCode | null>(initialLang);
  const [clozeTarget, setClozeTarget] = useState<string | null>(detail.word?.trim() || null);

  const [word, setWord] = useState<string>(detail.word?.trim() || '');
  const [reading, setReading] = useState('');
  const [definition, setDefinition] = useState('');
  const [translation, setTranslation] = useState(initialTranslation);
  const [cardNotes, setCardNotes] = useState('');

  const [cardShape, setCardShape] = useState<'vocab' | 'sentence'>('vocab');

  // ── Media capture state ─────────────────────────────────────────
  const [frame, setFrame] = useState<FrameCapture | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [clipEnabled, setClipEnabled] = useState(true);
  const [clipDurationSec, setClipDurationSec] = useState(4);

  // ── Save state ──────────────────────────────────────────────────
  const [saveTargets, setSaveTargets] = useState<SaveTargets>({
    anki: true,
    tokoriLocal: false,
    tokoriCloud: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<null | {
    ok: boolean;
    error?: string;
    perTarget?: Record<string, { ok: boolean; error?: string; id?: number; warning?: string }>;
  }>(null);

  // Apply settings once they land.
  useEffect(() => {
    if (!settings) return;
    setCardShape(settings.mining.defaultCardShape);
    setClipEnabled(settings.mining.clipEnabled);
    setClipDurationSec(settings.mining.clipDurationSec);
    // When the user enabled e.g. "tokoriLocal" globally, default the
    // modal's targets to match.
    setSaveTargets({ ...settings.save });
  }, [settings]);

  // ── Initial frame capture ───────────────────────────────────────
  // Runs once the user opens the modal so the preview is ready by the
  // time the user looks at it. Re-captures on demand via the
  // "Recapture" button.
  useEffect(() => {
    if (!settings?.mining.screenshotEnabled) return;
    if (!source?.video) return;
    let cancelled = false;
    (async () => {
      try {
        const f = await captureVideoFrame(source.video!, {
          maxWidth: settings.mining.screenshotMaxWidth,
          quality: settings.mining.screenshotQuality,
        });
        if (!cancelled) setFrame(f);
      } catch (e) {
        if (!cancelled) setFrameError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, settings]);

  // ── Token + dict for the selected cloze target ──────────────────
  const tokens = useMemo(() => tokenise(sentence, lang), [sentence, lang]);

  useEffect(() => {
    if (!clozeTarget || !lang) return;
    setWord(clozeTarget);
    sendMsgAsync<{ entries: DictEntry[] }>({ action: 'dictLookup', query: clozeTarget, lang })
      .then((res) => {
        if (!res.success) return;
        const entries = (res as { data?: { entries?: DictEntry[] } }).data?.entries || [];
        const hit =
          entries.find((e) => e.word === clozeTarget || e.reading === clozeTarget) || entries[0];
        if (!hit) return;
        if (!reading) setReading(hit.reading || '');
        if (!definition) setDefinition(hit.definitions.join(' / '));
      })
      .catch(() => {});
    // We only want to refetch when the cloze target changes; reading/
    // definition deps would clobber the user's manual edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clozeTarget, lang]);

  // ── Build the cloze-marked sentence for save ────────────────────
  const clozeMarker = settings?.mining.clozeMarker || 'cloze';
  const frontExtra = useMemo(() => {
    if (!clozeTarget || !sentence) return '';
    return markSentence(sentence, clozeTarget, clozeMarker);
  }, [sentence, clozeTarget, clozeMarker]);

  const canSave = !!word && Object.values(saveTargets).some(Boolean) && !saving;

  async function onSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveResult(null);
    try {
      // Record the clip last — it's the slowest step. If the user
      // cancelled in between we'd have wasted the recording.
      let clip: ClipCapture | null = null;
      if (clipEnabled && source?.video) {
        try {
          clip = await recordVideoClip(source.video, {
            durationSec: clipDurationSec,
            startSec: source.currentCue?.startSec,
            maxHeight: settings?.mining.clipMaxHeight,
          });
        } catch (e) {
          // Clip failure shouldn't block the rest of the card.
          warn('clip capture failed:', e);
        }
      }
      // For sentence-card mode we put the sentence itself in the `word`
      // slot (with the cloze around the target). Vocab mode keeps the
      // headword in `word`. Sentence is always carried alongside so
      // Anki's Sentence field still renders the full line.
      const wordToSend = cardShape === 'sentence' ? frontExtra || sentence : word;
      // Override save targets so per-modal toggles win.
      await setTabSaveTargets(saveTargets);
      const res = await sendMsgAsync({
        action: 'saveVocab',
        lang,
        word: wordToSend,
        reading,
        definition,
        sentence,
        translation,
        sourceUrl,
        frontExtra,
        cardNotes,
        kind: cardShape,
        image: frame ? { dataUrl: frame.dataUrl, mime: frame.mime } : undefined,
        clip: clip
          ? { dataUrl: clip.dataUrl, mime: clip.mime, durationSec: clip.durationSec }
          : undefined,
      });
      const r = res as {
        success: boolean;
        error?: string;
        results?: Record<string, { ok: boolean; error?: string; id?: number; warning?: string }>;
      };
      setSaveResult({ ok: r.success, error: r.error, perTarget: r.results });
      // Auto-close on full success after a short delay so the user
      // sees the green flash. On partial / total failure we hold the
      // modal open so they can read what went wrong.
      if (r.success) setTimeout(onClose, 900);
    } catch (e) {
      setSaveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function recapture() {
    if (!source?.video || !settings) return;
    setFrameError(null);
    try {
      const f = await captureVideoFrame(source.video, {
        maxWidth: settings.mining.screenshotMaxWidth,
        quality: settings.mining.screenshotQuality,
      });
      setFrame(f);
    } catch (e) {
      setFrameError(e instanceof Error ? e.message : String(e));
    }
  }

  const langInfo = lang ? getLanguage(lang) : undefined;
  const inSiteSource = !!source;

  return (
    <div
      onClick={onClose}
      style={s({
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483646', // sit just below per-token tooltips
        pointerEvents: 'auto',
      })}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="tk-modal"
        style={s({
          background: TOKENS.surface,
          color: TOKENS.text,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: TOKENS.radius,
          width: 'min(720px, 94vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: '18px 20px',
        })}
      >
        <Header
          onClose={onClose}
          title={
            inSiteSource
              ? `Mine card — ${source?.siteId === 'youtube' ? 'YouTube' : source?.siteId}`
              : 'Mine card'
          }
        />

        {/* Sentence + cloze picker */}
        <Section label="Sentence — click a word to set it as the studied target">
          <textarea
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            rows={2}
            style={s({
              width: '100%',
              background: TOKENS.bg,
              color: TOKENS.text,
              border: `1px solid ${TOKENS.border}`,
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '15px',
              lineHeight: '1.5',
              resize: 'vertical',
              marginBottom: '8px',
              fontFamily: 'inherit',
            })}
          />
          <div style={s({ fontSize: '20px', lineHeight: '1.6', wordBreak: 'break-word' })}>
            {tokens.map((t, i) => {
              if (!t.word)
                return (
                  <span key={i} style={s({ whiteSpace: 'pre-wrap' })}>
                    {t.text}
                  </span>
                );
              const isTarget = clozeTarget === t.text;
              return (
                <span
                  key={i}
                  onClick={() => setClozeTarget(isTarget ? null : t.text)}
                  style={s({
                    display: 'inline-block',
                    cursor: 'pointer',
                    padding: '1px 4px',
                    margin: '0 1px',
                    borderRadius: '4px',
                    background: isTarget ? TOKENS.primary : 'transparent',
                    color: isTarget ? TOKENS.primaryFg : TOKENS.text,
                    fontWeight: isTarget ? 600 : 'inherit',
                  })}
                >
                  {t.text}
                </span>
              );
            })}
          </div>
          {clozeTarget && (
            <div style={s({ marginTop: '8px', color: TOKENS.textMuted, fontSize: '12px' })}>
              Marked as{' '}
              <code>
                {clozeMarker === 'cloze' ? `{{c1::${clozeTarget}}}` : `<b>${clozeTarget}</b>`}
              </code>
            </div>
          )}
        </Section>

        <div style={s({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' })}>
          <Field label="Word" value={word} onChange={setWord} placeholder="Studied word" />
          <Field
            label="Reading"
            value={reading}
            onChange={setReading}
            placeholder={langInfo?.hasReading ? 'Pinyin / kana / IPA' : 'Reading'}
          />
        </div>
        <Field
          label="Definition"
          value={definition}
          onChange={setDefinition}
          multiline
          placeholder="Auto-filled from your dictionary"
        />
        <Field
          label="Translation"
          value={translation}
          onChange={setTranslation}
          multiline
          placeholder="Translated sentence (auto-filled from translated CC)"
        />
        <Field
          label="Notes"
          value={cardNotes}
          onChange={setCardNotes}
          multiline
          placeholder="Optional mnemonic / context"
        />

        {/* Card shape */}
        <Section label="Card shape">
          <div style={s({ display: 'flex', gap: '8px' })}>
            <Pill active={cardShape === 'vocab'} onClick={() => setCardShape('vocab')}>
              Vocab + context
            </Pill>
            <Pill active={cardShape === 'sentence'} onClick={() => setCardShape('sentence')}>
              Sentence card
            </Pill>
          </div>
        </Section>

        {/* Screenshot */}
        {inSiteSource && (
          <Section label="Screenshot">
            {frame ? (
              <div>
                <img
                  src={frame.dataUrl}
                  alt="Captured frame"
                  style={s({
                    width: '100%',
                    maxHeight: '220px',
                    objectFit: 'contain',
                    background: '#000',
                    borderRadius: '6px',
                    border: `1px solid ${TOKENS.border}`,
                  })}
                />
                <div
                  style={s({ display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' })}
                >
                  <button onClick={recapture} className="tk-btn tk-btn-outline">
                    Recapture at current time
                  </button>
                  <button onClick={() => setFrame(null)} className="tk-btn tk-btn-outline">
                    Remove
                  </button>
                  <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>
                    {frame.width}×{frame.height} · {(frame.byteLength / 1024).toFixed(0)} KB
                  </span>
                </div>
              </div>
            ) : (
              <div style={s({ display: 'flex', gap: '8px', alignItems: 'center' })}>
                <button onClick={recapture} className="tk-btn tk-btn-primary">
                  Capture frame
                </button>
                {frameError && (
                  <span style={s({ color: TOKENS.err, fontSize: '12px' })}>{frameError}</span>
                )}
              </div>
            )}
          </Section>
        )}

        {/* Clip */}
        {inSiteSource && (
          <Section label="Clip">
            <label
              style={s({ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' })}
            >
              <input
                type="checkbox"
                checked={clipEnabled}
                onChange={(e) => setClipEnabled(e.target.checked)}
              />
              <span>Record a short A/V clip on save</span>
            </label>
            {clipEnabled && (
              <div
                style={s({ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' })}
              >
                <span style={s({ color: TOKENS.textMuted, fontSize: '12px', width: '70px' })}>
                  Duration
                </span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={clipDurationSec}
                  onChange={(e) => setClipDurationSec(Number(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span
                  style={s({
                    color: TOKENS.textMuted,
                    fontSize: '12px',
                    width: '36px',
                    textAlign: 'right',
                  })}
                >
                  {clipDurationSec}s
                </span>
              </div>
            )}
          </Section>
        )}

        {/* Save targets */}
        <Section label="Save to">
          <div style={s({ display: 'flex', gap: '12px', flexWrap: 'wrap' })}>
            <TargetToggle
              checked={saveTargets.anki}
              onChange={(v) => setSaveTargets((p) => ({ ...p, anki: v }))}
              label="Anki"
            />
            <TargetToggle
              checked={saveTargets.tokoriLocal}
              onChange={(v) => setSaveTargets((p) => ({ ...p, tokoriLocal: v }))}
              label="Tokori desktop"
            />
            <TargetToggle
              checked={saveTargets.tokoriCloud}
              onChange={(v) => setSaveTargets((p) => ({ ...p, tokoriCloud: v }))}
              label="Tokori cloud"
              disabled={source?.requiresLocalOnly}
              disabledReason="This source is local-only (e.g. Netflix). Save to desktop instead."
            />
          </div>
        </Section>

        {/* Save action */}
        <div
          style={s({
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: '10px',
            marginTop: '14px',
          })}
        >
          {saveResult && <SaveResult result={saveResult} />}
          <button onClick={onClose} className="tk-btn tk-btn-ghost">
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!canSave}
            className="tk-btn tk-btn-primary"
            style={s({ height: '34px', padding: '0 16px', fontSize: '13px' })}
          >
            {saving ? 'Saving…' : 'Save card'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div
      style={s({
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '14px',
      })}
    >
      <strong
        style={s({
          fontSize: '13px',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: TOKENS.textMuted,
        })}
      >
        {title}
      </strong>
      <button
        onClick={onClose}
        aria-label="Close"
        style={s({
          background: 'transparent',
          color: TOKENS.textMuted,
          border: 'none',
          fontSize: '20px',
          lineHeight: '1',
          cursor: 'pointer',
        })}
      >
        ×
      </button>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s({ marginTop: '12px' })}>
      <div
        style={s({
          color: TOKENS.textMuted,
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: '6px',
        })}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const baseStyle: React.CSSProperties = {
    width: '100%',
    background: TOKENS.bg,
    color: TOKENS.text,
    border: `1px solid ${TOKENS.border}`,
    borderRadius: '6px',
    padding: '6px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
  };
  return (
    <div style={s({ marginTop: '10px' })}>
      <div
        style={s({
          color: TOKENS.textMuted,
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: '4px',
        })}
      >
        {label}
      </div>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          style={s({ ...baseStyle, resize: 'vertical', lineHeight: '1.45' })}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={s(baseStyle)}
        />
      )}
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Selected = the desktop's filled primary (neutral); unselected =
  // outline — the same segmented look shadcn toggle groups render.
  return (
    <button onClick={onClick} className={`tk-btn ${active ? 'tk-btn-primary' : 'tk-btn-outline'}`}>
      {children}
    </button>
  );
}

function TargetToggle({
  checked,
  onChange,
  label,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      title={disabled ? disabledReason : undefined}
      style={s({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      })}
    >
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function SaveResult({
  result,
}: {
  result: NonNullable<ReturnType<typeof useState<{ ok: boolean }>>[0]> & {
    error?: string;
    perTarget?: Record<string, { ok: boolean; error?: string; warning?: string }>;
  };
}) {
  if (result.ok && !Object.values(result.perTarget || {}).some((p) => p.warning)) {
    return <span style={s({ color: TOKENS.ok, fontSize: '12px' })}>Saved.</span>;
  }
  if (!result.ok) {
    return (
      <span style={s({ color: TOKENS.err, fontSize: '12px', maxWidth: '320px' })}>
        {result.error || 'Save failed.'}
      </span>
    );
  }
  // Partial / warnings
  const warnings = Object.entries(result.perTarget || {})
    .filter(([, p]) => p.warning)
    .map(([k, p]) => `${k}: ${p.warning}`)
    .join(' · ');
  return (
    <span style={s({ color: TOKENS.warn, fontSize: '12px', maxWidth: '320px' })}>{warnings}</span>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Wrap the first occurrence of `target` in `sentence` with the chosen
 *  marker. For cloze: `{{c1::target}}`. For bold: `<b>target</b>`.
 *  Falls back to plain sentence when the target isn't found verbatim
 *  (e.g. inflected forms — the desktop's vocab UI lets the user fix
 *  this post-save). */
// Shared mining helpers (markSentence, setTabSaveTargets) live in
// ./mining-helpers so the analyzer and the miner stay in lockstep.
