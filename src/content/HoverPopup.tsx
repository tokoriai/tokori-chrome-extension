/**
 * Hover popup — click-to-define overlay for any word on the page.
 *
 * Listens for `mouseup` globally; if the user has highlighted (or
 * single-clicked into) a piece of text we'd recognise as belonging to
 * a configured target language, anchor a popup at the selection rect
 * and show its dictionary entries.
 *
 * The layout mirrors the Tokori desktop app's word popover so the two
 * surfaces feel like one product:
 *
 *   ┌ headword + reading | 🔊 speak · status badge ┐
 *   ├ "Sentence analyzer" row                      ┤
 *   ├ definitions (or Generate-definition CTA)     ┤
 *   ├ New | Learning | Review | Known status grid  ┤
 *   └ Save to vocab · mine card · + List           ┘
 *
 * The popup is mode-agnostic — it always asks the service worker
 * for `dictLookup`, which decides which dict to consult (local first,
 * cloud fallback). Status grading + collections resolve desktop-first
 * with the signed-in cloud account as fallback; the grid and "+ List"
 * only render when one of those connections exists.
 */

import { useEffect, useRef, useState } from 'react';
import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { detectLanguage, type LanguageCode, getLanguage } from '../lib/languages';
import { TOKENS, s } from '../lib/theme';
import type { DictEntry } from '../lib/dictionaries/idb';

interface PopupState {
  query: string;
  /** Full sentence containing the query, derived from the surrounding
   *  block element. The analyzer needs the whole sentence to produce a
   *  useful breakdown; the popup itself only uses `query`. Falls back
   *  to `query` when we can't isolate a sentence (e.g. the selection
   *  spans multiple blocks or the page has no punctuation). */
  sentence: string;
  lang: LanguageCode;
  anchor: { x: number; y: number };
  /** "above" = popup's bottom sits at anchor.y - gap. "below" = popup's
   *  top sits at anchor.y + gap. Used by callers like the YT CC overlay
   *  that anchor at the *top* of the clicked character so the popup
   *  doesn't disappear off the bottom of the screen. */
  placement?: 'above' | 'below';
  /** Caller-supplied width (e.g. the CC field's measured width) so the
   *  popup matches the subtitle box instead of falling back to a fixed
   *  360px. Clamped to a sane range when applied. */
  width?: number;
}

type VocabStatus = 'new' | 'learning' | 'review' | 'mastered';

/** Word-status palette — same hues as the desktop's STATUS_BUTTONS
 *  (rose / amber / sky / emerald). `rgb` feeds the translucent active
 *  backgrounds; `color` is the text/label tone. */
const STATUS_META: { value: VocabStatus; label: string; rgb: string; color: string }[] = [
  { value: 'new', label: 'New', rgb: '244,63,94', color: '#f43f5e' },
  { value: 'learning', label: 'Learning', rgb: '245,158,11', color: '#f59e0b' },
  { value: 'review', label: 'Review', rgb: '14,165,233', color: '#0ea5e9' },
  { value: 'mastered', label: 'Known', rgb: '16,185,129', color: '#10b981' },
];

interface CollectionRow {
  id: number;
  name: string;
  isDefault?: boolean;
  wordCount?: number;
}

export function HoverPopup() {
  const [state, setState] = useState<PopupState | null>(null);
  const [entries, setEntries] = useState<DictEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When the lookup failed against the desktop, surface a more
   *  actionable message + jump-to-Tokori-desktop hint. The cloud /
   *  generic miss path keeps the plain-text "open settings" CTA. */
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  // ── Vocab status (desktop or cloud) ────────────────────────────
  const [status, setStatus] = useState<VocabStatus | null>(null);
  /** Which backend can grade / hold collections right now. `null`
   *  hides the status grid + "+ List" entirely (nothing to write to). */
  const [via, setVia] = useState<'desktop' | 'cloud' | null>(null);
  const [gradeBusy, setGradeBusy] = useState(false);
  const [gradeErr, setGradeErr] = useState<string | null>(null);

  // ── AI-generated definition (dictionary misses) ────────────────
  const [genEntry, setGenEntry] = useState<DictEntry | null>(null);
  const [genExamples, setGenExamples] = useState<Array<{ target: string; native?: string }>>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);

  /** "✨ Analyze selection" chip for selections too long for the dict
   *  popup (a sentence, a paragraph) — one click opens the analyzer on
   *  the selected passage. Anchored at the selection's end. */
  const [analyzeChip, setAnalyzeChip] = useState<null | {
    text: string;
    lang: LanguageCode;
    anchor: { x: number; y: number };
  }>(null);

  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      // Ignore clicks inside our own popup. The popup lives inside a
      // shadow root, and this listener sits on `document` — so
      // `e.target` is RETARGETED to the shadow host and a plain
      // `contains()` check never matches, which used to close the
      // popup on any inside click. composedPath() pierces the open
      // shadow boundary and gives us the real click target.
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const t = e.target as Node | null;
      const popup = popupRef.current;
      if (popup && (path.includes(popup) || (t && popup.contains(t)))) return;
      const chip = chipRef.current;
      if (chip && (path.includes(chip) || (t && chip.contains(t)))) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      setAnalyzeChip(null);
      if (!text) {
        setState(null);
        return;
      }
      const lang = detectLanguage(text);
      if (!lang) {
        // Selection isn't in a script we recognise — bail silently,
        // don't pop a noisy "no dict" tooltip on every random click.
        if (text.length > 80) setState(null);
        return;
      }
      if (text.length > 80) {
        // Too long for a word lookup — offer the analyzer instead. Cap
        // matches the analyzer's own sentence budget.
        setState(null);
        if (text.length <= 2000 && sel!.rangeCount > 0) {
          const rect = sel!.getRangeAt(0).getBoundingClientRect();
          setAnalyzeChip({
            text: text.slice(0, 400),
            lang,
            anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 8 },
          });
        }
        return;
      }
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      const sentence = extractSentenceAroundSelection(sel!, lang) || text;
      // Anchors are now viewport coords (popup uses position:fixed so
      // it stays put when the user scrolls).
      setState({
        query: text,
        sentence,
        lang,
        anchor: { x: rect.left, y: rect.bottom + 6 },
        placement: 'below',
      });
    };
    document.addEventListener('mouseup', onUp);

    // Programmatic trigger — callers (YouTube CC, future
    // tokenized-page surfaces) dispatch this event with an explicit
    // query + anchor so we don't have to rely on selection ranges.
    const onShow = (e: Event) => {
      const ce = e as CustomEvent<{
        query: string;
        sentence?: string;
        lang?: LanguageCode | null;
        anchor?: { x: number; y: number };
        placement?: 'above' | 'below';
        width?: number;
      }>;
      const q = ce.detail?.query?.trim();
      if (!q) return;
      const lang = (ce.detail?.lang as LanguageCode | undefined) || detectLanguage(q);
      if (!lang) return;
      const anchor = ce.detail?.anchor || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      setState({
        query: q,
        sentence: ce.detail?.sentence?.trim() || q,
        lang,
        anchor,
        placement: ce.detail?.placement || 'below',
        width: typeof ce.detail?.width === 'number' ? ce.detail.width : undefined,
      });
    };
    window.addEventListener('tokori-show-dict', onShow as EventListener);

    return () => {
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('tokori-show-dict', onShow as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!state) {
      setEntries(null);
      setError(null);
      setErrorCode(null);
      setStatus(null);
      setGradeErr(null);
      setGenEntry(null);
      setGenExamples([]);
      setGenErr(null);
      return;
    }
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setGenEntry(null);
    setGenExamples([]);
    setGenErr(null);
    sendMsgAsync<{ entries: DictEntry[] }>({
      action: 'dictLookup',
      query: state.query,
      lang: state.lang,
    })
      .then((res) => {
        if (res.success) {
          const data = (res as { data?: { entries?: DictEntry[] } }).data;
          // Exact-match only — the dict sources can fuzzy-match (cloud
          // /v1/dict/search returns prefix hits, desktop dict can
          // return inflected forms), but here we want "definitions for
          // exactly the word the user clicked", not a search result
          // list. Keep entries whose surface OR reading matches the
          // selected token verbatim.
          const q = state.query;
          const exact = (data?.entries || []).filter(
            (e) => e.word === q || e.reading === q || e.inflectionOf === q,
          );
          setEntries(exact);
        } else {
          setError((res as { error: string }).error || 'Lookup failed');
          setErrorCode((res as { errorCode?: string }).errorCode || null);
        }
      })
      .finally(() => setLoading(false));

    // Current SRS status + which backend (desktop/cloud) can grade.
    setStatus(null);
    setVia(null);
    setGradeErr(null);
    sendMsgAsync<{ status: string | null; via: 'desktop' | 'cloud' | null }>({
      action: 'getWordStatus',
      word: state.query,
    }).then((res) => {
      if (!res.success) return;
      const r = res as { status?: string | null; via?: 'desktop' | 'cloud' | null };
      setVia(r.via ?? null);
      const st = r.status;
      if (st === 'new' || st === 'learning' || st === 'review' || st === 'mastered') {
        setStatus(st);
      }
    });
  }, [state]);

  // First dictionary hit drives the header reading and what Save /
  // grading write as the gloss. Falls back to the AI-generated entry.
  const firstEntry = entries && entries.length > 0 ? entries[0] : null;
  const effectiveEntry = firstEntry ?? genEntry;

  // Reading fallback — even when NO dictionary has the word (names,
  // compounds), the background's `dictReadings` can compose pinyin
  // per-character, so the header still shows a pronunciation. Cached
  // background-side, so this is instant for repeated words.
  const [fallbackReading, setFallbackReading] = useState<string | null>(null);
  useEffect(() => {
    setFallbackReading(null);
    if (!state || !getLanguage(state.lang)?.hasReading) return;
    let cancelled = false;
    sendMsgAsync<{ readings: Record<string, string | null> }>({
      action: 'dictReadings',
      lang: state.lang,
      words: [state.query],
    }).then((res) => {
      if (cancelled || !res.success) return;
      const got = (res as { readings?: Record<string, string | null> }).readings || {};
      setFallbackReading(got[state.query] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [state]);
  const headerReading = effectiveEntry?.reading || fallbackReading;

  async function gradeWord(next: VocabStatus) {
    if (!state || gradeBusy) return;
    setGradeBusy(true);
    setGradeErr(null);
    const res = await sendMsgAsync<{ status: VocabStatus }>({
      action: 'setWordStatus',
      word: state.query,
      reading: effectiveEntry?.reading || fallbackReading || '',
      gloss: effectiveEntry?.definitions?.join('; ') || '',
      status: next,
    });
    setGradeBusy(false);
    if (res.success) {
      setStatus((res as { status?: VocabStatus }).status ?? next);
      // Nudge open caption overlays to re-pull the known-words map so
      // the new colour shows up immediately, not on the next poll.
      window.dispatchEvent(new CustomEvent('tokori-known-words-changed'));
    } else {
      setGradeErr((res as { error: string }).error);
    }
  }

  async function generateDefinition() {
    if (!state || genBusy) return;
    setGenBusy(true);
    setGenErr(null);
    const res = await sendMsgAsync<{
      entry: DictEntry;
      examples?: Array<{ target: string; native?: string }>;
    }>({ action: 'aiDefine', word: state.query, lang: state.lang });
    setGenBusy(false);
    if (res.success) {
      const r = res as { entry?: DictEntry; examples?: Array<{ target: string; native?: string }> };
      if (r.entry) {
        setGenEntry(r.entry);
        setGenExamples(r.examples || []);
      }
    } else {
      setGenErr((res as { error: string }).error);
    }
  }

  // Selection-length chip — mutually exclusive with the dict popup.
  const chipEl = analyzeChip ? (
    <button
      ref={chipRef}
      className="tk-btn tk-btn-primary tk-popup"
      onClick={() => {
        window.dispatchEvent(
          new CustomEvent('tokori-open-analyzer', {
            detail: { text: analyzeChip.text, lang: analyzeChip.lang },
          }),
        );
        setAnalyzeChip(null);
      }}
      title="Open the sentence analyzer on the selected text"
      style={s({
        position: 'fixed',
        left: `${Math.min(Math.max(analyzeChip.anchor.x, 80), window.innerWidth - 80)}px`,
        top: `${Math.min(analyzeChip.anchor.y, window.innerHeight - 44)}px`,
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        pointerEvents: 'auto',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
      })}
    >
      ✨ Analyze selection
    </button>
  ) : null;

  if (!state) return chipEl;

  const langInfo = getLanguage(state.lang);

  // For "above" placement we anchor by `bottom` (relative to the
  // viewport) so a tall popup grows upward instead of overflowing past
  // the anchor point. The y value the caller passes is the *top edge*
  // of the clicked element in viewport coords; we reserve a small gap
  // (8px) above the cue so the popup doesn't touch the text.
  const placeAbove = state.placement === 'above';
  const placementStyle: React.CSSProperties = placeAbove
    ? {
        bottom: `${Math.max(8, window.innerHeight - state.anchor.y + 8)}px`,
        left: `${state.anchor.x}px`,
      }
    : { top: `${state.anchor.y}px`, left: `${state.anchor.x}px` };

  // Match the caller's box (e.g. CC field) but clamp so a one-character
  // cue doesn't make a 30px popup and a giant cue doesn't span the
  // viewport.
  const popupWidth =
    state.width != null ? `${Math.max(300, Math.min(state.width, 720))}px` : '340px';

  const showMiss = entries && entries.length === 0 && !loading && !error && !genEntry;

  return (
    <div
      ref={popupRef}
      className="tk-popup"
      style={s({
        position: 'fixed',
        ...placementStyle,
        width: popupWidth,
        maxHeight: '480px',
        overflowY: 'auto',
        background: TOKENS.surface,
        color: TOKENS.text,
        border: `1px solid ${TOKENS.border}`,
        borderRadius: TOKENS.radius,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        padding: 0,
        pointerEvents: 'auto',
        fontSize: '14px',
        lineHeight: '1.4',
        zIndex: '2147483647',
      })}
    >
      {/* ── Header: word + reading | speak · status badge · close ── */}
      <div
        style={s({
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          padding: '14px 16px 11px',
          borderBottom: `1px solid ${TOKENS.border}`,
        })}
      >
        <div style={s({ minWidth: 0, flex: 1 })}>
          <div
            style={s({
              fontSize: '24px',
              lineHeight: '1.2',
              fontWeight: 600,
              fontFamily: 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
              wordBreak: 'break-word',
            })}
          >
            {state.query}
          </div>
          {headerReading && (
            <div
              className={state.lang === 'zh' ? 'tk-pinyin' : undefined}
              style={s({
                marginTop: '2px',
                fontSize: '13px',
                fontWeight: 600,
                color: TOKENS.ok,
              })}
            >
              {headerReading}
            </div>
          )}
        </div>
        <div style={s({ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 })}>
          <SpeakButton text={state.query} lang={state.lang} />
          {status && <StatusBadge status={status} />}
          {langInfo && !status && (
            <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>{langInfo.name}</span>
          )}
          <button
            onClick={() => setState(null)}
            style={s({
              background: 'transparent',
              color: TOKENS.textMuted,
              border: 'none',
              padding: '0 2px',
              fontSize: '18px',
              lineHeight: '1',
            })}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Sentence analyzer row ── */}
      <button
        onClick={() => {
          window.dispatchEvent(
            new CustomEvent('tokori-open-analyzer', {
              detail: { text: state.sentence, lang: state.lang },
            }),
          );
          setState(null);
        }}
        title="Open the sentence analyzer for the sentence around this word"
        style={s({
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          borderBottom: `1px solid ${TOKENS.border}`,
          padding: '8px 16px',
          fontSize: '11.5px',
          fontWeight: 500,
          color: TOKENS.text,
        })}
      >
        <ScanIcon />
        Sentence analyzer
      </button>

      {/* ── Definitions ── */}
      <div
        style={s({
          borderBottom: `1px solid ${TOKENS.border}`,
          maxHeight: '224px',
          overflowY: 'auto',
          padding: '10px 16px',
        })}
      >
        {loading && (
          <div
            style={s({
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: TOKENS.textMuted,
            })}
          >
            <div className="tk-spinner" /> Looking up…
          </div>
        )}

        {error && (
          <div style={s({ color: TOKENS.err, fontSize: '13px' })}>
            {error}{' '}
            {errorCode === 'desktop_dict_miss' || errorCode === 'desktop_dict_failed' ? (
              <>
                <button
                  className="tk-link"
                  onClick={() => sendMsg({ action: 'openOptionsPage' })}
                  style={s({ background: 'none', border: 'none', padding: 0 })}
                >
                  Extension settings
                </button>
                {' · '}
                <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>
                  Open Tokori desktop → Settings → Dictionaries to install one.
                </span>
              </>
            ) : (
              <button
                className="tk-link"
                onClick={() => sendMsg({ action: 'openOptionsPage' })}
                style={s({ background: 'none', border: 'none', padding: 0 })}
              >
                Open settings
              </button>
            )}
            {/* A dictionary miss can still be rescued by the AI. */}
            <div style={s({ marginTop: '8px' })}>
              <GenerateButton onClick={generateDefinition} busy={genBusy} />
              {genErr && (
                <div style={s({ color: TOKENS.err, fontSize: '12px', marginTop: '4px' })}>
                  {genErr}
                </div>
              )}
            </div>
          </div>
        )}

        {showMiss && (
          <div>
            <p
              style={s({
                color: TOKENS.textMuted,
                fontSize: '12.5px',
                fontStyle: 'italic',
                margin: '0 0 8px',
              })}
            >
              No dictionary entry for this word. Generate one with the AI — it'll be saved to your
              personal dictionary.
            </p>
            <GenerateButton onClick={generateDefinition} busy={genBusy} />
            {genErr && (
              <div style={s({ color: TOKENS.err, fontSize: '12px', marginTop: '6px' })}>
                {genErr}
              </div>
            )}
          </div>
        )}

        {!loading && !error && entries && entries.length > 0 && (
          <div>
            {entries.slice(0, 6).map((e, i) => (
              <EntryBlock key={i} entry={e} first={i === 0} lang={state.lang} />
            ))}
            {entries.length > 6 && (
              <div style={s({ color: TOKENS.textMuted, fontSize: '12px', marginTop: '6px' })}>
                +{entries.length - 6} more entries
              </div>
            )}
          </div>
        )}

        {genEntry && (
          <div>
            <DefinitionList definitions={genEntry.definitions} />
            {genExamples.length > 0 && (
              <div
                style={s({
                  marginTop: '10px',
                  paddingTop: '8px',
                  borderTop: `1px solid ${TOKENS.border}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                })}
              >
                <span
                  style={s({
                    fontSize: '10.5px',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: TOKENS.textMuted,
                  })}
                >
                  Examples
                </span>
                {genExamples.map((ex, i) => (
                  <div key={i}>
                    <div style={s({ fontSize: '12.5px', lineHeight: '1.4' })}>{ex.target}</div>
                    {ex.native && (
                      <div
                        style={s({
                          fontSize: '11.5px',
                          fontStyle: 'italic',
                          color: TOKENS.textMuted,
                        })}
                      >
                        {ex.native}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={s({ color: TOKENS.textMuted, fontSize: '10.5px', marginTop: '8px' })}>
              ✨ AI-generated — saved to your personal dictionary.
            </div>
          </div>
        )}
      </div>

      {/* ── Status grid (needs desktop or cloud) ── */}
      {via ? (
        <div
          style={s({
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '6px',
            padding: '10px 12px',
            borderBottom: `1px solid ${TOKENS.border}`,
          })}
        >
          {STATUS_META.map((opt) => {
            const active = status === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => void gradeWord(opt.value)}
                disabled={gradeBusy}
                style={s({
                  borderRadius: '8px',
                  padding: '6px 0',
                  fontSize: '11px',
                  fontWeight: 700,
                  transition: 'all 120ms ease',
                  border: active ? `1px solid rgba(${opt.rgb},0.4)` : `1px solid ${TOKENS.border}`,
                  background: active ? `rgba(${opt.rgb},0.15)` : 'transparent',
                  color: active ? opt.color : TOKENS.textMuted,
                  opacity: gradeBusy ? 0.5 : 1,
                })}
              >
                {opt.label}
              </button>
            );
          })}
          {gradeErr && (
            <div
              style={s({
                gridColumn: '1 / -1',
                color: TOKENS.err,
                fontSize: '11.5px',
              })}
            >
              {gradeErr}
            </div>
          )}
        </div>
      ) : (
        <div
          style={s({
            padding: '8px 16px',
            borderBottom: `1px solid ${TOKENS.border}`,
            color: TOKENS.textMuted,
            fontSize: '11px',
          })}
        >
          Pair the Tokori desktop app or sign in to track word status.
        </div>
      )}

      {/* ── Bottom actions: save · mine · list ── */}
      <BottomActions
        state={state}
        effectiveEntry={effectiveEntry}
        status={status}
        via={via}
        onSaved={() => {
          if (!status) setStatus('new');
          window.dispatchEvent(new CustomEvent('tokori-known-words-changed'));
        }}
        onClose={() => setState(null)}
      />
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────

function DefinitionList({ definitions }: { definitions: string[] }) {
  return (
    <div style={s({ color: TOKENS.text, display: 'flex', flexDirection: 'column', gap: '3px' })}>
      {definitions.map((d, i) => (
        <div key={i} style={s({ display: 'flex', gap: '8px', lineHeight: '1.45' })}>
          {definitions.length > 1 && (
            <span
              style={s({
                color: TOKENS.textMuted,
                minWidth: '18px',
                fontSize: '12px',
                fontVariantNumeric: 'tabular-nums',
              })}
            >
              {i + 1}.
            </span>
          )}
          <span style={s({ fontSize: '13px' })}>{d}</span>
        </div>
      ))}
    </div>
  );
}

function EntryBlock({
  entry,
  first,
  lang,
}: {
  entry: DictEntry;
  first: boolean;
  lang: LanguageCode;
}) {
  return (
    <div
      style={s({
        padding: first ? '0 0 8px' : '8px 0',
        borderTop: first ? 'none' : `1px solid ${TOKENS.border}`,
      })}
    >
      {/* The first entry's reading already sits in the header. */}
      {!first && entry.reading && (
        <div
          className={lang === 'zh' ? 'tk-pinyin' : undefined}
          style={s({
            color: TOKENS.ok,
            fontSize: '12.5px',
            marginBottom: '4px',
            fontWeight: 600,
          })}
        >
          {entry.reading}
        </div>
      )}
      <DefinitionList definitions={entry.definitions} />
      {entry.inflectionOf && (
        <div style={s({ color: TOKENS.textMuted, fontSize: '12px', marginTop: '4px' })}>
          inflected form of <em>{entry.inflectionOf}</em>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: VocabStatus }) {
  const opt = STATUS_META.find((o) => o.value === status);
  if (!opt) return null;
  return (
    <span
      style={s({
        flexShrink: 0,
        borderRadius: '6px',
        border: `1px solid rgba(${opt.rgb},0.4)`,
        background: `rgba(${opt.rgb},0.15)`,
        color: opt.color,
        padding: '2px 8px',
        fontSize: '10px',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      })}
    >
      {opt.label}
    </span>
  );
}

/** 🔊 button — cloud Edge-TTS when reachable (background returns MP3
 *  bytes), browser speechSynthesis otherwise. Re-click stops playback. */
function SpeakButton({ text, lang }: { text: string; lang: LanguageCode }) {
  const [busy, setBusy] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function stop() {
    audioRef.current?.pause();
    audioRef.current = null;
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    setBusy(false);
  }

  async function speak() {
    if (busy) {
      stop();
      return;
    }
    setBusy(true);
    const res = await sendMsgAsync<{ audio: string | null; mime?: string }>({
      action: 'tts',
      text,
      lang,
    });
    const audio = res.success ? (res as { audio?: string | null }).audio : null;
    if (audio) {
      const el = new Audio(
        `data:${(res as { mime?: string }).mime || 'audio/mpeg'};base64,${audio}`,
      );
      audioRef.current = el;
      el.onended = () => {
        audioRef.current = null;
        setBusy(false);
      };
      el.onerror = () => {
        audioRef.current = null;
        setBusy(false);
      };
      try {
        await el.play();
        return;
      } catch {
        audioRef.current = null;
        /* autoplay refused — fall through to speechSynthesis */
      }
    }
    // Keyless, offline fallback.
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = getLanguage(lang)?.locale || lang;
      u.onend = () => setBusy(false);
      u.onerror = () => setBusy(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={() => void speak()}
      title={busy ? 'Stop' : 'Read aloud'}
      aria-label={busy ? 'Stop' : 'Read aloud'}
      style={s({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        color: busy ? TOKENS.accent : TOKENS.textMuted,
      })}
    >
      {busy ? <div className="tk-spinner" /> : <VolumeIcon />}
    </button>
  );
}

function GenerateButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button className="tk-btn tk-btn-outline" onClick={onClick} disabled={busy}>
      {busy ? <div className="tk-spinner" /> : <span aria-hidden>✨</span>}
      {busy ? 'Generating…' : 'Generate definition'}
    </button>
  );
}

/** Save-to-vocab / mine / add-to-collection row at the popup's foot. */
function BottomActions({
  state,
  effectiveEntry,
  status,
  via,
  onSaved,
  onClose,
}: {
  state: PopupState;
  effectiveEntry: DictEntry | null;
  status: VocabStatus | null;
  via: 'desktop' | 'cloud' | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    const res = await sendMsgAsync({
      action: 'saveVocab',
      lang: state.lang,
      word: state.query,
      reading: effectiveEntry?.reading || '',
      definition: effectiveEntry?.definitions?.join(' / ') || '',
      sentence: state.sentence !== state.query ? state.sentence : '',
      sourceUrl: window.location.href,
    });
    setSaving(false);
    if (res.success) {
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 1800);
    } else {
      setSaveErr((res as { error: string }).error);
    }
  };

  const inVocab = status != null;

  return (
    <div style={s({ padding: '10px 12px' })}>
      <div style={s({ display: 'flex', gap: '6px', alignItems: 'stretch' })}>
        {inVocab && !saved ? (
          <span
            style={s({
              flex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              borderRadius: '6px',
              border: '1px solid rgba(16,185,129,0.3)',
              background: 'rgba(16,185,129,0.06)',
              color: '#10b981',
              fontSize: '11.5px',
              fontWeight: 500,
              padding: '5px 8px',
            })}
          >
            ✓ In vocab
          </span>
        ) : (
          /* The desktop's word popover renders Save-to-vocab as an
             OUTLINE button (`variant="outline"`), not a filled primary. */
          <button
            className="tk-btn tk-btn-outline"
            onClick={save}
            disabled={saving}
            style={s({ flex: 1 })}
          >
            {saving ? 'Saving…' : saved ? 'Saved ✓' : '⊕ Save to vocab'}
          </button>
        )}
        <button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent('tokori-open-miner', {
                detail: {
                  word: state.query,
                  sentence: state.sentence,
                  lang: state.lang,
                },
              }),
            );
            onClose();
          }}
          title="Open the sentence miner with this word pre-selected"
          aria-label="Mine card"
          className="tk-btn tk-btn-outline"
          style={s({ width: '32px', padding: 0 })}
        >
          ⛏
        </button>
        {via && (
          <button
            className="tk-btn tk-btn-outline"
            onClick={() => setListOpen((o) => !o)}
            title="Add to a collection"
            style={s({ background: listOpen ? TOKENS.surfaceHi : undefined })}
          >
            <span aria-hidden style={s({ fontSize: '12px' })}>
              +
            </span>
            List
          </button>
        )}
      </div>
      {saveErr && (
        <div style={s({ color: TOKENS.err, fontSize: '12px', marginTop: '6px' })}>{saveErr}</div>
      )}
      {listOpen && via && (
        <CollectionsPanel
          word={state.query}
          reading={effectiveEntry?.reading || ''}
          gloss={effectiveEntry?.definitions?.join('; ') || ''}
        />
      )}
    </div>
  );
}

/** Collection picker — expands under the action row when "+ List" is
 *  clicked. Lists the workspace's collections (desktop or cloud,
 *  whichever the background resolved), adds on click, and can create a
 *  new list inline. */
function CollectionsPanel({
  word,
  reading,
  gloss,
}: {
  word: string;
  reading: string;
  gloss: string;
}) {
  const [collections, setCollections] = useState<CollectionRow[] | null>(null);
  const [listVia, setListVia] = useState<'desktop' | 'cloud' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [addedId, setAddedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    sendMsgAsync<{ collections: CollectionRow[]; via: 'desktop' | 'cloud' }>({
      action: 'listCollections',
    }).then((res) => {
      if (cancelled) return;
      if (res.success) {
        const r = res as { collections?: CollectionRow[]; via?: 'desktop' | 'cloud' };
        setCollections(r.collections || []);
        setListVia(r.via ?? null);
      } else {
        setErr((res as { error: string }).error);
        setCollections([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function add(c: CollectionRow) {
    if (!listVia || busyId != null) return;
    setBusyId(c.id);
    setErr(null);
    const res = await sendMsgAsync({
      action: 'addToCollection',
      via: listVia,
      collectionId: c.id,
      word,
      reading,
      gloss,
    });
    setBusyId(null);
    if (res.success) {
      setAddedId(c.id);
      setTimeout(() => setAddedId(null), 1400);
    } else {
      setErr((res as { error: string }).error);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name || !listVia || creating) return;
    setCreating(true);
    setErr(null);
    const res = await sendMsgAsync<{ collection: CollectionRow }>({
      action: 'createCollection',
      via: listVia,
      name,
    });
    setCreating(false);
    if (res.success) {
      const c = (res as { collection?: CollectionRow }).collection;
      if (c) {
        setCollections((prev) => [...(prev || []), c]);
        setNewName('');
        void add(c);
      }
    } else {
      setErr((res as { error: string }).error);
    }
  }

  return (
    <div
      style={s({
        marginTop: '8px',
        border: `1px solid ${TOKENS.border}`,
        borderRadius: '8px',
        padding: '6px',
        background: TOKENS.surface,
      })}
    >
      <div
        style={s({
          padding: '2px 6px 6px',
          fontSize: '10.5px',
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: TOKENS.textMuted,
        })}
      >
        Add to collection {listVia ? `(${listVia})` : ''}
      </div>
      {collections === null ? (
        <div
          style={s({
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: TOKENS.textMuted,
            fontSize: '12px',
            padding: '4px 6px',
          })}
        >
          <div className="tk-spinner" /> Loading collections…
        </div>
      ) : (
        <div style={s({ display: 'flex', flexDirection: 'column' })}>
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => void add(c)}
              disabled={busyId != null}
              style={s({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                width: '100%',
                textAlign: 'left',
                background: addedId === c.id ? 'rgba(16,185,129,0.12)' : 'transparent',
                color: addedId === c.id ? '#10b981' : TOKENS.text,
                border: 'none',
                borderRadius: '6px',
                padding: '5px 6px',
                fontSize: '12.5px',
              })}
            >
              <span
                style={s({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0,
                })}
              >
                <span
                  style={s({
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  })}
                >
                  {c.name}
                </span>
                {c.isDefault && (
                  <span
                    style={s({
                      border: `1px solid ${TOKENS.border}`,
                      borderRadius: '4px',
                      padding: '0 4px',
                      fontSize: '9px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: TOKENS.textMuted,
                    })}
                  >
                    default
                  </span>
                )}
              </span>
              {busyId === c.id ? (
                <div className="tk-spinner" />
              ) : addedId === c.id ? (
                <span style={s({ fontSize: '11px' })}>added ✓</span>
              ) : (
                typeof c.wordCount === 'number' && (
                  <span style={s({ color: TOKENS.textMuted, fontSize: '10.5px' })}>
                    {c.wordCount}
                  </span>
                )
              )}
            </button>
          ))}
          <div style={s({ display: 'flex', gap: '4px', marginTop: '4px', padding: '0 2px' })}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
              placeholder="New list…"
              style={s({
                flex: 1,
                minWidth: 0,
                background: TOKENS.surfaceHi,
                color: TOKENS.text,
                border: `1px solid ${TOKENS.border}`,
                borderRadius: '6px',
                padding: '4px 8px',
                fontSize: '12px',
                outline: 'none',
              })}
            />
            <button
              className="tk-btn tk-btn-outline"
              onClick={() => void create()}
              disabled={creating || !newName.trim()}
              style={s({ height: '27px' })}
            >
              {creating ? '…' : 'Create'}
            </button>
          </div>
        </div>
      )}
      {err && (
        <div style={s({ color: TOKENS.err, fontSize: '11.5px', padding: '4px 6px' })}>{err}</div>
      )}
    </div>
  );
}

// ── Icons (inline SVG — no icon lib inside the shadow DOM) ────────

function VolumeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ opacity: 0.75 }}
    >
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <line x1="7" y1="12" x2="17" y2="12" />
    </svg>
  );
}

/** Walk up from the selection to the nearest block-level container,
 *  segment that container's text by sentence, and return the segment
 *  containing the user's selection. Falls back to the selection text
 *  itself if we can't isolate a sentence (the analyzer then degrades
 *  to single-word mode, which is the previous behaviour). */
function extractSentenceAroundSelection(sel: Selection, lang: LanguageCode): string {
  if (sel.rangeCount === 0) return '';
  const selected = sel.toString().trim();
  if (!selected) return '';
  const range = sel.getRangeAt(0);
  const startNode = range.startContainer;
  let block: HTMLElement | null =
    startNode.nodeType === Node.TEXT_NODE
      ? (startNode.parentElement as HTMLElement | null)
      : (startNode as HTMLElement);
  const BLOCK_TAGS =
    /^(P|DIV|LI|TD|TH|H[1-6]|BLOCKQUOTE|ARTICLE|SECTION|FIGCAPTION|DD|DT|MAIN|ASIDE|HEADER|FOOTER)$/;
  while (block && block.parentElement) {
    if (BLOCK_TAGS.test(block.tagName)) break;
    try {
      const disp = getComputedStyle(block).display;
      if (disp === 'block' || disp === 'list-item' || disp === 'flex' || disp === 'grid') break;
    } catch {
      /* getComputedStyle can throw on detached nodes */
    }
    block = block.parentElement;
  }
  if (!block) return selected;
  const fullText = (block.textContent || '').replace(/\s+/g, ' ').trim();
  if (!fullText) return selected;
  const idx = fullText.indexOf(selected);
  if (idx < 0) return selected;
  try {
    const locale = getLanguage(lang)?.locale || 'en';
    const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
    for (const piece of seg.segment(fullText)) {
      const start = piece.index;
      const end = piece.index + piece.segment.length;
      if (idx >= start && idx + selected.length <= end) {
        const out = piece.segment.trim();
        // Cap absurdly long "sentences" (pages with no punctuation in
        // a block) so we don't blow the AI context window.
        return out.length > 400 ? out.slice(0, 400) : out;
      }
    }
  } catch {
    /* Intl.Segmenter is available everywhere Chrome ships our MV3 */
  }
  return selected;
}
