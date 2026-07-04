/**
 * Sentence analyzer — full-sentence breakdown in a focused modal,
 * mirroring the Tokori desktop's sentence-analyzer dialog:
 *
 *   ┌ SENTENCE ANALYZER · LANGUAGE            Plain | Linguist ┐
 *   │ 你想去哪里？  (serif, per-char tone-coloured pinyin ruby) │
 *   │                                    [Pinyin] [🔊] [×]     │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ TRANSLATION      [Translate]  → card                     │
 *   │ AI SUMMARY       [Summarize]  → card (markdown-ish)      │
 *   │ WORD IN CONTEXT / INTERLINEAR GLOSS (mode-swapped)       │
 *   │ MINE TO WORKSPACE (screenshot + clip footer)             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Every word in the sentence is clickable: a dict tooltip with the
 * desktop-style status grid opens, and "✨ Explain here" asks the AI
 * what the word means in THIS sentence (the desktop's word-in-context
 * call). AI requests stay explicit — nothing fires on open.
 */

import { useEffect, useRef, useState } from 'react';
import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { TOKENS, s } from '../lib/theme';
import { getLanguage, type LanguageCode } from '../lib/languages';
import type { DictEntry } from '../lib/dictionaries/idb';
import type { Settings } from '../lib/settings';
import { getMiningSource, type MiningSource } from '../lib/mining/source';
import { captureVideoFrame, recordVideoClip, type FrameCapture } from '../lib/mining/capture';
import { tokenise, type Token as SentenceToken } from './sentence-tokens';
import { segmentText } from './youtube/caption-tokenize';
import { markSentence, setTabSaveTargets } from './mining-helpers';
import { RubyWord } from './RubyWord';
import { warn } from '../lib/log';

type Mode = 'plain' | 'linguist';
const MODE_KEY = 'tokori.analyzer.mode';
const READING_KEY = 'tokori.analyzer.reading';

const SERIF = 'Georgia, "Songti SC", "Noto Serif CJK SC", serif';

/** Status palette — mirrors the desktop's word-popover underline
 *  colours (rose/amber/sky; mastered gets no underline, emerald is
 *  reserved for its pill). */
const STATUS_META: Record<string, { label: string; color: string }> = {
  new: { label: 'New', color: '#fb7185' },
  learning: { label: 'Learning', color: '#fbbf24' },
  review: { label: 'Review', color: '#0ea5e9' },
  mastered: { label: 'Known', color: '#34d399' },
};
const STATUS_ORDER = ['new', 'learning', 'review', 'mastered'] as const;
export type WordStatus = (typeof STATUS_ORDER)[number];

function statusUnderline(status: string | undefined): string {
  if (!status) return '2px dotted rgba(148,163,184,0.4)';
  if (status === 'mastered') return '2px solid transparent';
  return `2px solid ${STATUS_META[status]?.color || 'transparent'}`;
}

const TTS_LOCALE: Record<string, string> = {
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  en: 'en-US',
};

/** Browser TTS. The desktop's fancier TTS providers aren't reachable
 *  over the local API, so speechSynthesis is the portable path — it
 *  ships decent zh/ja voices on every Chromium install. */
function speak(text: string, lang: LanguageCode | null) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = TTS_LOCALE[lang] || lang;
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch {
    /* platform without TTS — the button is a no-op */
  }
}

function SpeakBtn({
  text,
  lang,
  title,
}: {
  text: string;
  lang: LanguageCode | null;
  title: string;
}) {
  return (
    <button
      className="tk-iconbtn"
      onClick={(e) => {
        e.stopPropagation();
        speak(text, lang);
      }}
      title={title}
      aria-label={title}
    >
      🔊
    </button>
  );
}

interface ProviderAvailability {
  desktopPaired: boolean;
  cloudSignedIn: boolean;
}

interface TokenLookup {
  reading?: string;
  /** First-entry definitions, capped to 3 lines for the inline tooltip. */
  defs: string[];
  /** Set when the defs come from a close-but-not-exact dict hit (e.g.
   *  the dict only had a longer word starting with this token). The
   *  tooltip labels the defs with this word so they aren't mistaken
   *  for the token's own entry. */
  matchedWord?: string;
}

export function SentenceAnalyzerModal({
  sentence: requestedSentence,
  lang,
  cues,
  initialIndex,
  onClose,
}: {
  sentence: string;
  lang: LanguageCode | null;
  /** When opened from a video surface (caption overlay / sidebar), the
   *  full cue list + the requested cue's index. Enables the header's
   *  ‹ › pager, which steps the analysis to the previous/next subtitle
   *  line AND seeks the video there — the desktop dialog's sentence
   *  pager, adapted to timed cues. */
  cues?: Array<{ text: string; start: number }>;
  initialIndex?: number;
  onClose: () => void;
}) {
  // ── Cue pager ───────────────────────────────────────────────────
  const [cueIdx, setCueIdx] = useState<number | null>(initialIndex ?? null);
  useEffect(() => {
    setCueIdx(initialIndex ?? null);
  }, [requestedSentence, initialIndex]);
  const sentence = cues && cueIdx != null && cues[cueIdx] ? cues[cueIdx].text : requestedSentence;
  const goToCue = (n: number) => {
    if (!cues || !cues[n]) return;
    setCueIdx(n);
    // Follow along in the player so the frame under the modal matches
    // the line being analyzed (and a mined screenshot grabs the right
    // moment).
    const video = document.querySelector<HTMLVideoElement>('video');
    if (video) {
      try {
        video.currentTime = cues[n].start + 0.01;
      } catch {
        /* not seekable right now */
      }
    }
  };
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'plain');
  /** Reading (pinyin/furigana) row toggle — on by default, persisted. */
  const [showReading, setShowReading] = useState<boolean>(
    () => localStorage.getItem(READING_KEY) !== '0',
  );
  const toggleReading = () =>
    setShowReading((prev) => {
      const next = !prev;
      localStorage.setItem(READING_KEY, next ? '1' : '0');
      return next;
    });
  /** Word → SRS status from the paired desktop workspace; drives the
   *  desktop-style status underlines + the tooltip's status grid. */
  const [knownWords, setKnownWords] = useState<Map<string, string>>(new Map());
  const [provider, setProvider] = useState<ProviderAvailability | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  // ── AI panels ───────────────────────────────────────────────────
  // Summary (whole-sentence breakdown) lives in both modes; the third
  // section swaps between word-in-context (plain) and gloss (linguist),
  // same arrangement as the desktop dialog.
  const [summary, setSummary] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryErrCode, setSummaryErrCode] = useState<string | null>(null);
  const [gloss, setGloss] = useState('');
  const [glossing, setGlossing] = useState(false);
  const [glossErr, setGlossErr] = useState<string | null>(null);
  const [wordX, setWordX] = useState<null | {
    word: string;
    text: string;
    loading: boolean;
    error?: string;
  }>(null);

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // Resolve provider availability once so we can decide whether to
  // show the explain button or the "needs desktop / cloud" CTA — both
  // surfaces use the same source of truth (the cached settings
  // snapshot from the service worker). Also keep the full Settings
  // payload around — the inline-mining section below needs it for
  // workspace id, screenshot opts, and clip defaults.
  useEffect(() => {
    sendMsg({ action: 'getSettings' }, (res) => {
      if (!res?.success) {
        setProvider({ desktopPaired: false, cloudSignedIn: false });
        return;
      }
      const data = (res as { data?: Settings }).data;
      if (data) setSettings(data);
      setProvider({
        desktopPaired: !!data?.localApi?.token && !!data?.desktopOnline,
        cloudSignedIn: !!data?.cloud?.token,
      });
    });
  }, []);

  // ── Inline mining state ─────────────────────────────────────────
  const sourceRef = useRef<MiningSource | null>(getMiningSource());
  const source = sourceRef.current;
  const [frame, setFrame] = useState<FrameCapture | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [clipEnabled, setClipEnabled] = useState(false);
  const [clipDurationSec, setClipDurationSec] = useState(4);
  const [mineSaving, setMineSaving] = useState(false);
  const [mineSaveResult, setMineSaveResult] = useState<null | {
    ok: boolean;
    error?: string;
    warning?: string;
  }>(null);

  useEffect(() => {
    if (!settings) return;
    setClipEnabled(settings.mining.clipEnabled);
    setClipDurationSec(settings.mining.clipDurationSec);
  }, [settings]);

  // Auto-capture the first frame on mount so it's ready by the time
  // the user scrolls to the mining section.
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

  // Reset transient AI state whenever the sentence changes.
  useEffect(() => {
    setSummary('');
    setSummaryErr(null);
    setSummaryErrCode(null);
    setSummarizing(false);
    setGloss('');
    setGlossErr(null);
    setGlossing(false);
    setWordX(null);
  }, [sentence, lang]);

  // ── Known-word statuses (paired desktop / cloud) ────────────────
  const loadKnownWords = () => {
    sendMsgAsync<{ items?: Array<{ word: string; status: string }> }>({
      action: 'getKnownWords',
    }).then((r) => {
      if (!r.success) return;
      const items = (r as { items?: Array<{ word: string; status: string }> }).items || [];
      const next = new Map<string, string>();
      for (const it of items) if (it.word) next.set(it.word, it.status || 'new');
      setKnownWords(next);
    });
  };
  useEffect(loadKnownWords, []);

  /** Optimistically recolor, then persist to the workspace. On failure
   *  re-sync from the background cache so the UI doesn't lie. */
  const setWordStatus = (word: string, status: WordStatus) => {
    const data = tokenDataRef.current.get(word);
    setKnownWords((prev) => new Map(prev).set(word, status));
    sendMsgAsync({
      action: 'setWordStatus',
      word,
      status,
      reading: data?.reading,
      gloss: data?.defs?.[0],
    }).then((res) => {
      if (!res.success) {
        warn('setWordStatus failed:', (res as { error?: string }).error);
        loadKnownWords();
      } else {
        window.dispatchEvent(new CustomEvent('tokori-known-words-changed'));
      }
    });
  };

  // ── Sentence translation ────────────────────────────────────────
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translationEngine, setTranslationEngine] = useState<string | null>(null);
  useEffect(() => {
    setTranslation(null);
    setTranslationEngine(null);
    setTranslating(false);
  }, [sentence, lang]);

  const runTranslate = () => {
    setTranslating(true);
    setTranslation(null);
    sendMsgAsync<{ translation?: string; engine?: string }>({
      action: 'translate',
      text: sentence,
      from: lang || undefined,
      to: 'en',
    })
      .then((res) => {
        if (res.success) {
          const d = (res as { data?: { translation?: string; engine?: string } }).data;
          setTranslation(d?.translation || '');
          setTranslationEngine(d?.engine || null);
        } else {
          setTranslation(null);
          setSummaryErr((res as { error?: string }).error || 'Translation failed');
        }
      })
      .finally(() => setTranslating(false));
  };

  // Tokenise with Intl.Segmenter immediately so the modal renders
  // without waiting on the network, then upgrade to the desktop's
  // jieba segmentation when paired.
  const [tokens, setTokens] = useState<SentenceToken[]>(() => tokenise(sentence, lang));
  useEffect(() => {
    setTokens(tokenise(sentence, lang));
    if (!lang) return;
    let cancelled = false;
    segmentText(sentence, lang).then((toks) => {
      if (cancelled || !toks.length) return;
      setTokens(toks.map((t) => ({ text: t.text, word: t.kind === 'word' })));
    });
    return () => {
      cancelled = true;
    };
  }, [sentence, lang]);

  // Per-token dict lookups: pinyin/reading ruby above each token and
  // the inline tooltip when the user clicks one. Single fetch per
  // unique token text, cached for the modal's lifetime.
  const [tokenData, setTokenData] = useState<Map<string, TokenLookup>>(new Map());
  const tokenDataRef = useRef(tokenData);
  tokenDataRef.current = tokenData;
  const [activeToken, setActiveToken] = useState<null | {
    text: string;
    centerX: number;
    bottom: number;
  }>(null);

  /** Words whose def-lookup already fired — separate from tokenData so
   *  the instant readings batch below can't suppress the def fetch. */
  const lookedUpRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setTokenData(new Map());
    setActiveToken(null);
    lookedUpRef.current = new Set();
  }, [sentence, lang]);

  // Instant ruby: ONE batch call resolves every token's reading from the
  // background's session cache (IDB dict → desktop dict → per-character
  // compose). Repeated words across sentences render pinyin immediately;
  // the per-token dictLookup below refines with the exact entry's
  // reading and fills the tooltip defs.
  useEffect(() => {
    if (!lang || !getLanguage(lang)?.hasReading) return;
    const words = [...new Set(tokens.filter((t) => t.word).map((t) => t.text))];
    if (!words.length) return;
    let cancelled = false;
    sendMsgAsync<{ readings: Record<string, string | null> }>({
      action: 'dictReadings',
      lang,
      words,
    }).then((res) => {
      if (cancelled || !res.success) return;
      const got = (res as { readings?: Record<string, string | null> }).readings || {};
      setTokenData((prev) => {
        const next = new Map(prev);
        for (const [w, r] of Object.entries(got)) {
          if (!r) continue;
          const cur = next.get(w);
          if (cur?.reading) continue; // an exact dict reading already landed
          next.set(w, { ...(cur || { defs: [] }), reading: r });
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [tokens, lang]);

  useEffect(() => {
    if (!lang) return;
    for (const t of tokens) {
      if (!t.word) continue;
      if (lookedUpRef.current.has(t.text)) continue;
      lookedUpRef.current.add(t.text);
      const text = t.text;
      sendMsgAsync<{ entries: DictEntry[] }>({ action: 'dictLookup', query: text, lang })
        .then((res) => {
          if (!res.success) return;
          const entries = (res as { data?: { entries?: DictEntry[] } }).data?.entries || [];
          // Only an exact-form hit may supply the reading — a prefix
          // match's reading belongs to a different (longer) word and
          // rendering it over this token shows wrong pinyin.
          const exact = entries.find((e) => e.word === text || e.reading === text);
          if (exact) {
            setTokenData((prev) =>
              new Map(prev).set(text, {
                reading: exact.reading || prev.get(text)?.reading,
                defs: exact.definitions.slice(0, 3),
              }),
            );
            return;
          }
          const closest = entries[0];
          setTokenData((prev) => {
            const cur = prev.get(text);
            return new Map(prev).set(
              text,
              closest
                ? { ...cur, defs: closest.definitions.slice(0, 3), matchedWord: closest.word }
                : { defs: [], reading: cur?.reading },
            );
          });
        })
        .catch(() => {
          /* swallow — a single failed token shouldn't poison the modal */
        });
    }
  }, [tokens, lang]);

  const langInfo = lang ? getLanguage(lang) : undefined;
  // Leipzig-style interlinear glossing marks up morphology (case,
  // conjugation, particles) — Chinese has none of that to gloss, so the
  // Linguist mode is hidden for zh and the section stays on
  // word-in-context. The desktop app draws the same line.
  const showLinguist = lang !== 'zh';
  const effectiveMode: Mode = showLinguist ? mode : 'plain';
  const showReadings = !!langInfo?.hasReading && showReading;
  const isChinese = lang === 'zh';
  const readingLabel = isChinese ? 'Pinyin' : lang === 'ja' ? 'Furigana' : 'Reading';
  const canSetStatus = !!provider?.desktopPaired && typeof settings?.localWorkspaceId === 'number';
  const aiAvailable = !!provider && (provider.desktopPaired || provider.cloudSignedIn);

  const runSummary = () => {
    setSummarizing(true);
    setSummaryErr(null);
    setSummaryErrCode(null);
    setSummary('');
    sendMsgAsync<{ explanation: string }>({ action: 'aiExplain', text: sentence, lang })
      .then((res) => {
        if (res.success) {
          setSummary((res as { data?: { explanation?: string } }).data?.explanation || '');
        } else {
          setSummaryErr((res as { error: string }).error || 'AI request failed');
          setSummaryErrCode((res as { errorCode?: string }).errorCode || null);
        }
      })
      .finally(() => setSummarizing(false));
  };

  const runGloss = () => {
    setGlossing(true);
    setGlossErr(null);
    setGloss('');
    sendMsgAsync<{ explanation: string }>({
      action: 'aiExplain',
      text:
        `Produce a Leipzig-style interlinear gloss for this sentence, as exactly three lines ` +
        `of plain text (morpheme-broken sentence / aligned Leipzig glosses / quoted free ` +
        `translation), no markdown:\n${sentence}`,
      lang,
    })
      .then((res) => {
        if (res.success) {
          setGloss((res as { data?: { explanation?: string } }).data?.explanation || '');
        } else {
          setGlossErr((res as { error: string }).error || 'AI request failed');
        }
      })
      .finally(() => setGlossing(false));
  };

  /** The desktop's "what does X mean *here*" call. Triggered from the
   *  token tooltip's ✨ button; renders in the Word-in-context card. */
  const explainWord = (word: string) => {
    setActiveToken(null);
    setMode('plain');
    setWordX({ word, text: '', loading: true });
    sendMsgAsync<{ explanation: string }>({
      action: 'aiExplain',
      text:
        `In the sentence: "${sentence}"\n\nWhat does "${word}" mean here? Answer with exactly ` +
        `three short numbered lines: 1. its meaning in this specific sentence, 2. the part of ` +
        `speech, 3. a concise reason given the surrounding context.`,
      lang,
    }).then((res) => {
      if (res.success) {
        setWordX({
          word,
          text: (res as { data?: { explanation?: string } }).data?.explanation || '',
          loading: false,
        });
      } else {
        setWordX({ word, text: '', loading: false, error: (res as { error?: string }).error });
      }
    });
  };

  // ── Mining handlers ─────────────────────────────────────────────
  const canMine =
    !!provider?.desktopPaired && typeof settings?.localWorkspaceId === 'number' && !!source?.video;
  const mineDisabledReason = !provider?.desktopPaired
    ? 'Pair the Tokori desktop app to enable saving.'
    : settings && typeof settings.localWorkspaceId !== 'number'
      ? 'Pick a workspace in Options → Desktop first.'
      : !source?.video
        ? 'No video element on this page to capture from.'
        : '';

  async function recaptureFrame() {
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

  async function saveToWorkspace() {
    if (!canMine || !settings) return;
    setMineSaving(true);
    setMineSaveResult(null);
    try {
      let clip: { dataUrl: string; mime: string; durationSec: number } | undefined;
      if (clipEnabled && source?.video) {
        try {
          const c = await recordVideoClip(source.video, {
            durationSec: clipDurationSec,
            startSec: source.currentCue?.startSec,
            maxHeight: settings.mining.clipMaxHeight,
          });
          clip = { dataUrl: c.dataUrl, mime: c.mime, durationSec: c.durationSec };
        } catch (e) {
          warn('clip capture failed:', e);
        }
      }
      await setTabSaveTargets({ anki: false, tokoriLocal: true, tokoriCloud: false });
      const target = activeToken?.text || wordX?.word;
      const marker = settings.mining.clozeMarker;
      const frontExtra = target ? markSentence(sentence, target, marker) : '';
      const res = await sendMsgAsync({
        action: 'saveVocab',
        lang,
        word: frontExtra || sentence,
        sentence,
        sourceUrl: source?.sourceUrl || window.location.href,
        frontExtra,
        kind: 'sentence' as const,
        image: frame ? { dataUrl: frame.dataUrl, mime: frame.mime } : undefined,
        clip,
      });
      const r = res as {
        success: boolean;
        error?: string;
        results?: Record<string, { ok: boolean; error?: string; warning?: string }>;
      };
      const localRes = r.results?.tokoriLocal;
      if (r.success && localRes?.ok) {
        setMineSaveResult({ ok: true, warning: localRes.warning });
        setTimeout(onClose, 900);
      } else {
        setMineSaveResult({ ok: false, error: localRes?.error || r.error || 'Save failed.' });
      }
    } catch (e) {
      setMineSaveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setMineSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={s({
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647',
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
          maxHeight: '84vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 0,
        })}
      >
        {/* ── Header (pinned): label + mode pill, sentence + controls ── */}
        <div style={s({ padding: '16px 22px 14px', borderBottom: `1px solid ${TOKENS.border}` })}>
          <div
            style={s({
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              marginBottom: '10px',
            })}
          >
            <div
              style={s({
                fontSize: '12px',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: TOKENS.textMuted,
              })}
            >
              Sentence analyzer{langInfo ? ` · ${langInfo.name}` : ''}
            </div>
            {showLinguist && <ModePill mode={mode} onChange={setMode} />}
          </div>

          <div style={s({ display: 'flex', alignItems: 'flex-start', gap: '12px' })}>
            <div
              style={s({
                flex: 1,
                minWidth: 0,
                fontFamily: SERIF,
                fontSize: '21px',
                lineHeight: showReadings ? '2.3' : '1.6',
                wordBreak: 'break-word',
              })}
            >
              {tokens.map((t, i) => {
                if (!t.word) {
                  return (
                    <span key={i} style={s({ whiteSpace: 'pre-wrap' })}>
                      {t.text}
                    </span>
                  );
                }
                const data = tokenData.get(t.text);
                const reading = data?.reading;
                const isActive = activeToken?.text === t.text;
                return (
                  <span
                    key={i}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setActiveToken((prev) =>
                        prev && prev.text === t.text
                          ? null
                          : {
                              text: t.text,
                              centerX: rect.left + rect.width / 2,
                              bottom: rect.bottom,
                            },
                      );
                    }}
                    style={s({
                      display: 'inline-block',
                      padding: '0 2px 1px',
                      borderRadius: '4px 4px 0 0',
                      cursor: 'pointer',
                      background: isActive ? TOKENS.surfaceHi : 'transparent',
                      borderBottom: statusUnderline(knownWords.get(t.text)),
                    })}
                  >
                    {showReadings ? (
                      reading ? (
                        <RubyWord word={t.text} reading={reading} lang={lang} />
                      ) : (
                        // Reserve the annotation row while lookups are in
                        // flight so the line doesn't reflow when they land.
                        <ruby>
                          {t.text}
                          <rt className="tk-rt">{data ? '' : '…'}</rt>
                        </ruby>
                      )
                    ) : (
                      t.text
                    )}
                  </span>
                );
              })}
            </div>
            <div style={s({ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 })}>
              {cues && cues.length > 1 && cueIdx != null && (
                <span style={s({ display: 'inline-flex', alignItems: 'center', gap: '5px' })}>
                  <button
                    className="tk-iconbtn"
                    onClick={() => goToCue(cueIdx - 1)}
                    disabled={cueIdx <= 0}
                    title="Previous subtitle line (seeks the video)"
                    aria-label="Previous subtitle line"
                  >
                    ‹
                  </button>
                  <span
                    style={s({
                      fontSize: '10.5px',
                      color: TOKENS.textMuted,
                      fontVariantNumeric: 'tabular-nums',
                    })}
                  >
                    {cueIdx + 1}/{cues.length}
                  </span>
                  <button
                    className="tk-iconbtn"
                    onClick={() => goToCue(cueIdx + 1)}
                    disabled={cueIdx >= cues.length - 1}
                    title="Next subtitle line (seeks the video)"
                    aria-label="Next subtitle line"
                  >
                    ›
                  </button>
                </span>
              )}
              {!!langInfo?.hasReading && (
                <button
                  onClick={toggleReading}
                  aria-pressed={showReading}
                  title={showReading ? `Hide ${readingLabel}` : `Show ${readingLabel}`}
                  style={s({
                    borderRadius: '999px',
                    border: `1px solid ${TOKENS.border}`,
                    padding: '3px 11px',
                    fontSize: '11px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    background: showReading ? TOKENS.text : 'transparent',
                    color: showReading ? TOKENS.surface : TOKENS.textMuted,
                  })}
                >
                  {readingLabel}
                </button>
              )}
              <SpeakBtn text={sentence} lang={lang} title="Read sentence aloud" />
              <button
                onClick={onClose}
                style={s({
                  background: 'transparent',
                  color: TOKENS.textMuted,
                  border: 'none',
                  fontSize: '20px',
                  lineHeight: '1',
                  cursor: 'pointer',
                  padding: '0 2px',
                })}
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        {/* ── Scrollable body: stacked sections ── */}
        <div
          style={s({
            overflowY: 'auto',
            padding: '16px 22px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(148,163,184,0.35) transparent',
          })}
        >
          {/* Translation */}
          <Section
            label="Translation"
            action={
              <OutlineBtn onClick={runTranslate} disabled={translating}>
                {translating ? 'Translating…' : '🌐 Translate'}
              </OutlineBtn>
            }
          >
            <Card>
              {translation != null ? (
                <>
                  {translation}
                  {translationEngine && (
                    <span
                      style={s({ color: TOKENS.textMuted, fontSize: '11px', marginLeft: '8px' })}
                    >
                      via {translationEngine === 'tokori' ? 'Tokori desktop AI' : 'Google (free)'}
                    </span>
                  )}
                </>
              ) : translating ? (
                <Muted>Translating…</Muted>
              ) : (
                <Muted>
                  Click <em>Translate</em> to render the sentence in English.
                </Muted>
              )}
            </Card>
          </Section>

          {/* AI summary */}
          <Section
            label="AI summary"
            action={
              aiAvailable ? (
                <OutlineBtn onClick={runSummary} disabled={summarizing}>
                  {summarizing ? 'Thinking…' : summary ? '✨ Regenerate' : '✨ Summarize'}
                </OutlineBtn>
              ) : undefined
            }
          >
            <Card>
              {summarizing ? (
                <span
                  style={s({
                    display: 'inline-flex',
                    gap: '8px',
                    alignItems: 'center',
                    color: TOKENS.textMuted,
                  })}
                >
                  <span className="tk-spinner" /> Asking the tutor…
                </span>
              ) : summaryErr ? (
                <span style={s({ color: TOKENS.err, fontSize: '13px' })}>
                  {summaryErr}{' '}
                  {summaryErrCode === 'ai_no_provider' && (
                    <button
                      onClick={() => sendMsg({ action: 'openOptionsPage' })}
                      className="tk-link"
                      style={s({ background: 'none', border: 'none', padding: 0 })}
                    >
                      Open settings
                    </button>
                  )}
                </span>
              ) : summary ? (
                <MiniMarkdown text={summary} />
              ) : !aiAvailable && provider ? (
                <div style={s({ color: TOKENS.textMuted, fontSize: '13px', lineHeight: '1.5' })}>
                  AI explanations need a paired Tokori desktop app or a signed-in cloud account.
                  <div style={s({ display: 'flex', gap: '8px', marginTop: '10px' })}>
                    <OutlineBtn onClick={() => sendMsg({ action: 'desktopPair' })}>
                      Pair desktop app
                    </OutlineBtn>
                    <AccentBtn onClick={() => sendMsg({ action: 'openCloudAuth' })}>
                      Sign in to cloud
                    </AccentBtn>
                  </div>
                </div>
              ) : (
                <Muted>AI translation, grammar breakdown, and nuance — one call.</Muted>
              )}
            </Card>
          </Section>

          {/* Word in context ⟷ Interlinear gloss */}
          {effectiveMode === 'linguist' ? (
            <Section
              label="Interlinear gloss"
              action={
                aiAvailable ? (
                  <OutlineBtn onClick={runGloss} disabled={glossing}>
                    {glossing ? 'Generating…' : gloss ? '📖 Regenerate' : '📖 Generate gloss'}
                  </OutlineBtn>
                ) : undefined
              }
            >
              <Card>
                {glossing ? (
                  <span
                    style={s({
                      display: 'inline-flex',
                      gap: '8px',
                      alignItems: 'center',
                      color: TOKENS.textMuted,
                    })}
                  >
                    <span className="tk-spinner" /> Generating Leipzig gloss…
                  </span>
                ) : glossErr ? (
                  <span style={s({ color: TOKENS.err, fontSize: '13px' })}>{glossErr}</span>
                ) : gloss ? (
                  <pre
                    style={s({
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: '12.5px',
                      lineHeight: '1.6',
                    })}
                  >
                    {gloss}
                  </pre>
                ) : (
                  <Muted>
                    Three lines: morpheme-broken sentence, Leipzig-abbreviated glosses (1SG, PST,
                    NOM, …), and a free translation.
                  </Muted>
                )}
              </Card>
            </Section>
          ) : (
            <Section label="Word in context">
              {wordX ? (
                <Card>
                  <div
                    style={s({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '6px',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: TOKENS.textMuted,
                    })}
                  >
                    ✨ Meaning of{' '}
                    <span
                      style={s({
                        fontFamily: SERIF,
                        fontSize: '14px',
                        textTransform: 'none',
                        color: TOKENS.text,
                      })}
                    >
                      {wordX.word}
                    </span>{' '}
                    here
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => setWordX(null)}
                      style={s({
                        background: 'none',
                        border: 'none',
                        color: TOKENS.textMuted,
                        fontSize: '12px',
                        cursor: 'pointer',
                        padding: 0,
                      })}
                    >
                      × Clear
                    </button>
                  </div>
                  {wordX.loading ? (
                    <span
                      style={s({
                        display: 'inline-flex',
                        gap: '8px',
                        alignItems: 'center',
                        color: TOKENS.textMuted,
                      })}
                    >
                      <span className="tk-spinner" /> Asking the tutor…
                    </span>
                  ) : wordX.error ? (
                    <span style={s({ color: TOKENS.err, fontSize: '13px' })}>{wordX.error}</span>
                  ) : (
                    <MiniMarkdown text={wordX.text} />
                  )}
                </Card>
              ) : (
                <Muted>
                  Click any word in the sentence above — a dictionary tooltip opens with the status
                  grid{aiAvailable ? ' and an ✨ Explain-here button' : ''}.
                </Muted>
              )}
            </Section>
          )}

          {/* Mine to workspace */}
          {source?.video && (
            <Section
              label="Mine to workspace"
              action={
                (activeToken?.text || wordX?.word) && (
                  <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>
                    Cloze target:{' '}
                    <code style={s({ color: TOKENS.accent })}>
                      {activeToken?.text || wordX?.word}
                    </code>
                  </span>
                )
              }
            >
              {frame ? (
                <div>
                  <img
                    src={frame.dataUrl}
                    alt="Captured frame"
                    style={s({
                      width: '100%',
                      maxHeight: '180px',
                      objectFit: 'contain',
                      background: '#000',
                      borderRadius: '8px',
                      border: `1px solid ${TOKENS.border}`,
                    })}
                  />
                  <div
                    style={s({
                      display: 'flex',
                      gap: '8px',
                      marginTop: '6px',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    })}
                  >
                    <OutlineBtn onClick={recaptureFrame}>Recapture</OutlineBtn>
                    <OutlineBtn onClick={() => setFrame(null)}>Remove</OutlineBtn>
                    <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>
                      {frame.width}×{frame.height} · {(frame.byteLength / 1024).toFixed(0)} KB
                    </span>
                  </div>
                </div>
              ) : (
                <div style={s({ display: 'flex', gap: '8px', alignItems: 'center' })}>
                  <AccentBtn onClick={recaptureFrame}>Capture frame</AccentBtn>
                  {frameError && (
                    <span style={s({ color: TOKENS.err, fontSize: '12px' })}>{frameError}</span>
                  )}
                </div>
              )}

              <div
                style={s({
                  marginTop: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                })}
              >
                <label
                  style={s({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    cursor: 'pointer',
                    fontSize: '12px',
                  })}
                >
                  <input
                    type="checkbox"
                    checked={clipEnabled}
                    onChange={(e) => setClipEnabled(e.target.checked)}
                  />
                  Record clip on save
                </label>
                {clipEnabled && (
                  <span style={s({ display: 'inline-flex', alignItems: 'center', gap: '6px' })}>
                    <input
                      type="range"
                      min={1}
                      max={8}
                      step={1}
                      value={clipDurationSec}
                      onChange={(e) => setClipDurationSec(Number(e.target.value))}
                      style={{ width: '120px', cursor: 'pointer' }}
                    />
                    <span style={s({ color: TOKENS.textMuted, fontSize: '11px', width: '30px' })}>
                      {clipDurationSec}s
                    </span>
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {mineSaveResult &&
                  (mineSaveResult.ok ? (
                    <span style={s({ color: TOKENS.ok, fontSize: '12px' })}>Saved.</span>
                  ) : (
                    <span style={s({ color: TOKENS.err, fontSize: '12px', maxWidth: '280px' })}>
                      {mineSaveResult.error}
                    </span>
                  ))}
                <AccentBtn
                  onClick={saveToWorkspace}
                  disabled={!canMine || mineSaving}
                  title={!canMine ? mineDisabledReason : undefined}
                >
                  {mineSaving ? 'Saving…' : 'Save to workspace'}
                </AccentBtn>
              </div>
              {!canMine && mineDisabledReason && (
                <div
                  style={s({
                    marginTop: '6px',
                    color: TOKENS.textMuted,
                    fontSize: '11px',
                    textAlign: 'right',
                  })}
                >
                  {mineDisabledReason}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>

      {activeToken && (
        <TokenTranslation
          text={activeToken.text}
          centerX={activeToken.centerX}
          top={activeToken.bottom + 6}
          data={tokenData.get(activeToken.text)}
          lang={lang}
          status={knownWords.get(activeToken.text)}
          canSetStatus={canSetStatus}
          canExplain={aiAvailable}
          onExplainHere={() => explainWord(activeToken.text)}
          onSetStatus={(st) => setWordStatus(activeToken.text, st)}
          onClose={() => setActiveToken(null)}
        />
      )}
    </div>
  );
}

// ── Layout primitives (desktop dialog look) ───────────────────────

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div
        style={s({
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '8px',
        })}
      >
        <h4
          style={s({
            margin: 0,
            fontSize: '11px',
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: TOKENS.textMuted,
          })}
        >
          {label}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={s({
        minHeight: '44px',
        borderRadius: '12px',
        border: `1px solid ${TOKENS.border}`,
        background: TOKENS.surfaceHi,
        padding: '11px 14px',
        fontSize: '13.5px',
        lineHeight: '1.55',
      })}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={s({ color: TOKENS.textMuted })}>{children}</span>;
}

/* Desktop-shadcn button variants — classes live in SHADOW_CSS so they
 * get real :hover states, which inline styles can't express. */

function OutlineBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button className="tk-btn tk-btn-outline" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function AccentBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button className="tk-btn tk-btn-primary" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function ModePill({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div
      style={s({
        display: 'inline-flex',
        alignItems: 'center',
        border: `1px solid ${TOKENS.border}`,
        borderRadius: '999px',
        padding: '2px',
        fontSize: '11px',
        flexShrink: 0,
      })}
    >
      {(['plain', 'linguist'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          style={s({
            borderRadius: '999px',
            border: 'none',
            padding: '3px 11px',
            fontWeight: 500,
            cursor: 'pointer',
            background: mode === m ? TOKENS.text : 'transparent',
            color: mode === m ? TOKENS.surface : TOKENS.textMuted,
          })}
        >
          {m === 'plain' ? 'Plain' : 'Linguist'}
        </button>
      ))}
    </div>
  );
}

/** Tiny markdown renderer for tutor replies: `**bold**` spans, `- `
 *  bullets, and paragraph breaks. Enough for the summary / in-context
 *  formats the prompts ask for, without shipping a markdown lib into
 *  every page. */
function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div style={s({ display: 'flex', flexDirection: 'column', gap: '4px' })}>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} style={{ height: '2px' }} />;
        const isBullet = /^[-•]\s+/.test(trimmed);
        const content = isBullet ? trimmed.replace(/^[-•]\s+/, '') : trimmed;
        return (
          <div key={i} style={s({ display: 'flex', gap: '7px' })}>
            {isBullet && <span style={s({ color: TOKENS.textMuted })}>•</span>}
            <span style={{ minWidth: 0 }}>{renderBold(content)}</span>
          </div>
        );
      })}
    </div>
  );
}

function renderBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function TokenTranslation({
  text,
  centerX,
  top,
  data,
  lang,
  status,
  canSetStatus,
  canExplain,
  onExplainHere,
  onSetStatus,
  onClose,
}: {
  text: string;
  centerX: number;
  top: number;
  data: TokenLookup | undefined;
  lang: LanguageCode | null;
  /** Current SRS status of the word in the paired workspace. */
  status: string | undefined;
  /** Whether the status grid is actionable (desktop paired + workspace picked). */
  canSetStatus: boolean;
  /** AI reachable → show the desktop-style "Explain here" affordance. */
  canExplain: boolean;
  onExplainHere: () => void;
  onSetStatus: (status: WordStatus) => void;
  onClose: () => void;
}) {
  const isChinese = lang === 'zh';
  // Dismiss on outside click. We mount a one-shot capture-phase listener
  // that fires *after* the click that opened us (because that one stopped
  // propagation inside the modal), then tears itself down.
  useEffect(() => {
    const opened = Date.now();
    const onDocClick = (e: MouseEvent) => {
      if (Date.now() - opened < 50) return; // ignore the opening click
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (
        path.some((el) => el instanceof HTMLElement && el.dataset?.tkTokenPopup === '1') ||
        (e.target as HTMLElement | null)?.closest?.('[data-tk-token-popup]')
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [onClose]);

  const loading = !data;
  const hasEntry = !!data && (data.defs.length > 0 || !!data.reading);

  return (
    <div
      data-tk-token-popup="1"
      onClick={(e) => e.stopPropagation()}
      style={s({
        position: 'fixed',
        left: `${centerX}px`,
        top: `${top}px`,
        transform: 'translateX(-50%)',
        background: TOKENS.bg,
        border: `1px solid ${TOKENS.border}`,
        borderRadius: '10px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        padding: '10px 12px',
        minWidth: '200px',
        maxWidth: '320px',
        zIndex: '2147483647',
        fontSize: '13px',
        lineHeight: '1.45',
        color: TOKENS.text,
        textAlign: 'left',
        pointerEvents: 'auto',
      })}
    >
      <div
        style={s({
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: '4px',
        })}
      >
        <span style={s({ fontSize: '17px', fontWeight: 600, fontFamily: SERIF })}>{text}</span>
        <span style={s({ display: 'inline-flex', alignItems: 'center', gap: '6px' })}>
          <SpeakBtn text={text} lang={lang} title="Read word aloud" />
          <button
            onClick={onClose}
            aria-label="Close"
            style={s({
              background: 'transparent',
              border: 'none',
              color: TOKENS.textMuted,
              fontSize: '14px',
              lineHeight: '1',
              padding: '0 0 0 2px',
              cursor: 'pointer',
            })}
          >
            ×
          </button>
        </span>
      </div>
      {data?.reading && (
        <div
          className={isChinese ? 'tk-pinyin' : undefined}
          style={s({ color: TOKENS.ok, fontSize: '13px', fontWeight: 600, marginBottom: '6px' })}
        >
          {data.reading}
        </div>
      )}
      {loading && (
        <div
          style={s({ color: TOKENS.textMuted, display: 'flex', gap: '6px', alignItems: 'center' })}
        >
          <div className="tk-spinner" /> Looking up…
        </div>
      )}
      {!loading && !hasEntry && (
        <div style={s({ color: TOKENS.textMuted })}>No dictionary entry.</div>
      )}
      {!loading && hasEntry && data!.matchedWord && data!.matchedWord !== text && (
        <div style={s({ color: TOKENS.textMuted, fontSize: '12px', marginBottom: '4px' })}>
          closest entry: {data!.matchedWord}
        </div>
      )}
      {!loading && hasEntry && data!.defs.length > 0 && (
        <div style={s({ display: 'flex', flexDirection: 'column', gap: '2px' })}>
          {data!.defs.map((d, i) => (
            <div key={i} style={s({ display: 'flex', gap: '6px' })}>
              <span style={s({ color: TOKENS.textMuted, minWidth: '14px' })}>{i + 1}.</span>
              <span>{d}</span>
            </div>
          ))}
        </div>
      )}
      {/* Desktop-style 4-button status grid — saves the word into the
          paired workspace with the chosen SRS status. */}
      {canSetStatus && !loading && (
        <div
          style={s({
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '6px',
            marginTop: '10px',
          })}
        >
          {STATUS_ORDER.map((st) => {
            const meta = STATUS_META[st];
            const active = status === st;
            return (
              <button
                key={st}
                onClick={(e) => {
                  e.stopPropagation();
                  onSetStatus(st);
                }}
                style={s({
                  borderRadius: '8px',
                  border: `1px solid ${active ? meta.color : TOKENS.border}`,
                  background: active ? `${meta.color}26` : 'transparent',
                  color: active ? meta.color : TOKENS.textMuted,
                  fontSize: '11px',
                  fontWeight: '600',
                  padding: '5px 0',
                  cursor: 'pointer',
                })}
              >
                {meta.label}
              </button>
            );
          })}
        </div>
      )}
      {canExplain && !loading && (
        <button
          className="tk-btn tk-btn-outline"
          onClick={(e) => {
            e.stopPropagation();
            onExplainHere();
          }}
          title="Ask the AI what this word means in this specific sentence"
          style={s({ marginTop: '8px', width: '100%', height: '28px' })}
        >
          ✨ Explain here
        </button>
      )}
    </div>
  );
}

// markSentence now lives in ./mining-helpers (shared with MiningModal).
