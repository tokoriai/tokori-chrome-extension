/**
 * YouTube subtitle overlay.
 *
 * Sits *on top of the video* (anchored to the player's bounding rect,
 * not the viewport) and replaces YouTube's built-in CC. Two lines:
 *
 *   • Top:    native CC in the user's target language. Each character
 *             (CJK) / word (Latin) is its own clickable span; clicking
 *             one fires `tokori-show-dict`, which the HoverPopup picks
 *             up to render the definition. Words already in the paired
 *             desktop workspace get a subtle "known" treatment.
 *   • Bottom: machine-translated version (currently English).
 *
 * Behaviour notes:
 *   • The overlay's parent is `position: fixed`, but `top`/`left` are
 *     recomputed from `#movie_player`'s `getBoundingClientRect` each
 *     frame so it follows resize / theater / mini-player. Native CC
 *     (`.ytp-caption-window-container`) is hidden via injected CSS.
 *   • Drag-anywhere: mousedown on the overlay starts a drag tracker;
 *     if the cursor moves >4px before mouseup, the drag wins and the
 *     subsequent click (e.g. on a character) is suppressed. Otherwise
 *     the click bubbles through and triggers a dict lookup.
 *   • Position is stored as a `{ x, y }` offset *relative to the player
 *     centre* so it doesn't drift when the user resizes the window.
 *   • Target language selector + auto-translate fallback is in the
 *     toolbar; see youtube-cues.ts for the track-selection logic.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { TOKENS, s } from '../lib/theme';
import { detectLanguage, getLanguage, LANGUAGES, type LanguageCode } from '../lib/languages';
import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { type Token, tokenize, segmentText } from './youtube/caption-tokenize';
import { CaptionSidebar } from './youtube/CaptionSidebar';
import { RubyWord } from './RubyWord';
import { DEFAULT_CAPTION_STYLE, statusColorFor, type CaptionStyle } from './youtube/caption-style';
import { CaptionSettingsPanel } from './youtube/CaptionSettingsPanel';
import { registerMiningSource, type MiningSource } from '../lib/mining/source';

interface Cue {
  start: number;
  dur: number;
  text: string;
}

/** Player-relative drag offset. `dx`/`dy` are measured from the
 *  bottom-centre of the player, so the overlay sticks when the player
 *  resizes (theater mode, fullscreen). */
interface DragOffset {
  dx: number;
  dy: number;
}

const POS_STORAGE_KEY = 'youtubeCaptionOffset';
const LANG_STORAGE_KEY = 'youtubeTargetLang';
const BLUR_TRANSLATED_KEY = 'youtubeBlurTranslated';
const STYLE_STORAGE_KEY = 'youtubeCaptionStyle';
const SIDEBAR_OPEN_KEY = 'youtubeSidebarOpen';
const NATIVE_CC_HIDE_STYLE_ID = 'tokori-yt-hide-native-cc';
const DRAG_THRESHOLD_PX = 4;

/** Rough Han / kana test — only tokens containing these scripts get a
 *  ruby reading lookup; Latin words inside a zh/ja cue never will. */
const CJK_TOKEN_RE = /[㐀-鿿豈-﫿぀-ヿ]/;

export function YouTubeEnhancer() {
  const [native, setNative] = useState<Cue[]>([]);
  const [translated, setTranslated] = useState<Cue[]>([]);
  const [activeNative, setActiveNative] = useState<Cue | null>(null);
  const [activeTranslated, setActiveTranslated] = useState<Cue | null>(null);
  // Sticky memory of the most recent cue, kept across "no cue right
  // now" gaps and across CC-off toggles so the overlay can show the
  // last line dimmed while CC is paused (instead of vanishing).
  const lastNativeRef = useRef<Cue | null>(null);
  const lastTranslatedRef = useRef<Cue | null>(null);
  const [isYouTube, setIsYouTube] = useState(false);
  const [offset, setOffset] = useState<DragOffset | null>(null);
  const [targetLang, setTargetLang] = useState<LanguageCode | null>(null);
  const [hovered, setHovered] = useState(false);
  /** Word → vocab status from the paired desktop workspace. Drives
   *  per-status underline colors on the native subtitle line. */
  const [knownWords, setKnownWords] = useState<Map<string, string>>(new Map());
  /** Which backend the vocab came from + the last fetch failure —
   *  drives the toolbar pill so "no colours" is explainable instead of
   *  silent (desktop down, cloud 402, workspace unset, …). */
  const [knownMeta, setKnownMeta] = useState<{ source: string; error: string | null }>({
    source: 'none',
    error: null,
  });
  /** When the active translated cue's `start` matches this, the bottom
   *  line is unblurred. Resets to null on every new cue so the user
   *  reads native first each time. */
  const [revealedCueStart, setRevealedCueStart] = useState<number | null>(null);
  /** User-controlled master toggle. Persisted so the choice survives
   *  refreshes. Defaults to ON — the whole point of the feature is to
   *  force native-first reading. */
  const [blurTranslated, setBlurTranslated] = useState<boolean>(true);
  /** Caption styling (font sizes + colours). Tweakable from the gear
   *  icon; persisted under STYLE_STORAGE_KEY. */
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Caption sidebar (full transcript with jump / mine / lookup).
   *  Persisted so it survives navigation within YouTube. */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Measured native-subtitle box width, used to size the lookup popup
   *  so it matches the cue field instead of falling back to a fixed
   *  360px. Captured after each render of the native row. */
  const [nativeBoxWidth, setNativeBoxWidth] = useState<number | null>(null);
  const nativeBoxRef = useRef<HTMLDivElement | null>(null);
  // Mirrors YouTube's own CC button state. Starts as `null` so the
  // overlay doesn't render anything until the MAIN script reports a
  // first reading — avoids a flash of overlay before YT decides.
  const [ccEnabled, setCcEnabled] = useState<boolean | null>(null);
  // Player rect (viewport-relative). Updated each animation frame so
  // the overlay tracks resize / theater / fullscreen instantly.
  const [playerRect, setPlayerRect] = useState<DOMRect | null>(null);
  /** Mirrors ytd-watch-flexy's theater / fullscreen attributes so the
   *  caption sidebar can pick its layout (dock beside the default-view
   *  player; theater + fullscreen pin an overlay drawer to the
   *  player's right edge). */
  const [viewMode, setViewMode] = useState<{ theater: boolean; fullscreen: boolean }>({
    theater: false,
    fullscreen: false,
  });

  const rafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ moved: boolean }>({ moved: false });
  /** Token drag-select state: `from` is the token index the drag
   *  started on; `moved` flips once the pointer crosses another token.
   *  Lets the user sweep across a name / compound the segmenter split
   *  apart and look up the combined text. */
  const selDragRef = useRef<{ active: boolean; from: number; moved: boolean }>({
    active: false,
    from: -1,
    moved: false,
  });
  /** Swallows the click that immediately follows a completed
   *  drag-select so it doesn't fire a second, single-token lookup. */
  const selSuppressRef = useRef(false);

  useEffect(() => {
    setIsYouTube(/(^|\.)youtube\.com$/.test(window.location.hostname));
  }, []);

  // ── Persisted prefs ─────────────────────────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    try {
      chrome.storage.local.get([POS_STORAGE_KEY, LANG_STORAGE_KEY], (r) => {
        const p = r[POS_STORAGE_KEY] as DragOffset | undefined;
        if (p && Number.isFinite(p.dx) && Number.isFinite(p.dy)) setOffset(p);
        const stored = r[LANG_STORAGE_KEY] as LanguageCode | undefined;
        if (stored) setTargetLang(stored);
        else {
          sendMsg<{ data: { defaultTargetLang: LanguageCode } }>(
            { action: 'getSettings' },
            (res) => {
              if (res?.success) {
                const lang = (res as { data?: { defaultTargetLang?: LanguageCode } }).data
                  ?.defaultTargetLang;
                if (lang) setTargetLang(lang);
              }
            },
          );
        }
      });
    } catch {
      /* extension context invalidated — leave default */
    }
  }, [isYouTube]);

  // ── Known words from the paired desktop ────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    let alive = true;
    async function loadKnown() {
      const r = await sendMsgAsync<{
        items?: Array<{ word: string; status: string }>;
        words?: string[];
        source?: string;
        error?: string | null;
      }>({ action: 'getKnownWords' });
      if (!alive || !r.success) return;
      const meta = r as { source?: string; error?: string | null };
      setKnownMeta({ source: meta.source || 'none', error: meta.error ?? null });
      const items = (r as { items?: Array<{ word: string; status: string }> }).items;
      const next = new Map<string, string>();
      if (items && items.length) {
        for (const it of items) if (it.word) next.set(it.word, it.status || 'new');
      } else {
        // Back-compat: a service worker on the old payload only sends
        // `words: string[]`. Treat them all as `new` so they at least
        // light up; the underline color will be inconsistent until the
        // next extension reload.
        const ws = (r as { words?: string[] }).words || [];
        for (const w of ws) if (w) next.set(w, 'new');
      }
      setKnownWords(next);
    }
    void loadKnown();
    const t = window.setInterval(loadKnown, 30_000);
    // Fired by the dict popup right after a status grade / save so the
    // caption colours update immediately instead of on the next poll.
    const onChanged = () => void loadKnown();
    window.addEventListener('tokori-known-words-changed', onChanged);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener('tokori-known-words-changed', onChanged);
    };
  }, [isYouTube]);

  // ── Persisted blur-translated toggle ───────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    try {
      chrome.storage.local.get([BLUR_TRANSLATED_KEY, SIDEBAR_OPEN_KEY], (r) => {
        const v = r[BLUR_TRANSLATED_KEY];
        if (typeof v === 'boolean') setBlurTranslated(v);
        if (typeof r[SIDEBAR_OPEN_KEY] === 'boolean') setSidebarOpen(r[SIDEBAR_OPEN_KEY]);
      });
    } catch {
      /* extension context invalidated — keep default */
    }
  }, [isYouTube]);

  const toggleSidebar = (v: boolean) => {
    setSidebarOpen(v);
    try {
      chrome.storage.local.set({ [SIDEBAR_OPEN_KEY]: v });
    } catch {}
  };

  // A previous build injected a sidebar toggle into the player's own
  // control bar; it's gone (the ☰ CC pill owns the toggle now), but a
  // stale button can survive extension reloads on already-open tabs.
  useEffect(() => {
    if (!isYouTube) return;
    document.getElementById('tokori-sidebar-ytp-btn')?.remove();
  }, [isYouTube]);

  // ── Persisted caption style ────────────────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    try {
      chrome.storage.local.get(STYLE_STORAGE_KEY, (r) => {
        const v = r[STYLE_STORAGE_KEY] as Partial<CaptionStyle> | undefined;
        if (v && typeof v === 'object') {
          setCaptionStyle({ ...DEFAULT_CAPTION_STYLE, ...v });
        }
      });
    } catch {
      /* extension context invalidated — keep defaults */
    }
  }, [isYouTube]);

  const patchCaptionStyle = (patch: Partial<CaptionStyle>) => {
    setCaptionStyle((prev) => {
      const next = { ...prev, ...patch };
      try {
        chrome.storage.local.set({ [STYLE_STORAGE_KEY]: next });
      } catch {}
      return next;
    });
  };
  const resetCaptionStyle = () => {
    setCaptionStyle(DEFAULT_CAPTION_STYLE);
    try {
      chrome.storage.local.set({ [STYLE_STORAGE_KEY]: DEFAULT_CAPTION_STYLE });
    } catch {}
  };

  // ── Forward target lang to MAIN-world cue script ───────────────
  useEffect(() => {
    if (!isYouTube || !targetLang) return;
    window.dispatchEvent(
      new CustomEvent('tokori-yt-set-target-lang', {
        detail: { lang: targetLang },
      }),
    );
  }, [isYouTube, targetLang]);

  // ── Replace YouTube's native CC ────────────────────────────────
  // Only hide the built-in caption window when our overlay is actually
  // about to render — i.e. CC is on AND we have cues to show. When the
  // user toggles CC off in the player, we drop the stylesheet so the
  // native CC reappears for any other consumer.
  useEffect(() => {
    if (!isYouTube) return;
    const haveCues = native.length > 0 || translated.length > 0;
    const overlayActive = haveCues && ccEnabled !== false;
    const existing = document.getElementById(NATIVE_CC_HIDE_STYLE_ID);
    if (!overlayActive) {
      existing?.remove();
      return;
    }
    if (!existing) {
      const style = document.createElement('style');
      style.id = NATIVE_CC_HIDE_STYLE_ID;
      style.textContent = `
        .ytp-caption-window-container,
        .caption-window,
        .ytp-caption-segment { display: none !important; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  }, [isYouTube, native.length, translated.length, ccEnabled]);

  // ── Cue ingest + CC-state mirror ───────────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    const onNative = (e: Event) => {
      const ce = e as CustomEvent<{ cues: Cue[] }>;
      if (ce.detail?.cues) setNative(ce.detail.cues);
    };
    const onTranslated = (e: Event) => {
      const ce = e as CustomEvent<{ cues: Cue[] }>;
      if (ce.detail?.cues) setTranslated(ce.detail.cues);
    };
    const onCcState = (e: Event) => {
      const ce = e as CustomEvent<{ enabled: boolean }>;
      setCcEnabled(!!ce.detail?.enabled);
    };
    window.addEventListener('tokori-yt-native-cues', onNative as EventListener);
    window.addEventListener('tokori-yt-translated-cues', onTranslated as EventListener);
    window.addEventListener('tokori-yt-cc-state', onCcState as EventListener);
    return () => {
      window.removeEventListener('tokori-yt-native-cues', onNative as EventListener);
      window.removeEventListener('tokori-yt-translated-cues', onTranslated as EventListener);
      window.removeEventListener('tokori-yt-cc-state', onCcState as EventListener);
    };
  }, [isYouTube]);

  // ── RAF loop: active cue + player rect ─────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    const tick = () => {
      const video = document.querySelector('video');
      const player = document.getElementById('movie_player') as HTMLElement | null;
      const rectSource = player || video;
      if (rectSource) {
        const rect = rectSource.getBoundingClientRect();
        // Only update state when the rect meaningfully changes — avoids a
        // re-render per frame when nothing moved.
        setPlayerRect((prev) => {
          if (!prev) return rect;
          if (
            Math.abs(prev.left - rect.left) < 0.5 &&
            Math.abs(prev.top - rect.top) < 0.5 &&
            Math.abs(prev.width - rect.width) < 0.5 &&
            Math.abs(prev.height - rect.height) < 0.5
          )
            return prev;
          return rect;
        });
      }
      if (video) {
        const t = video.currentTime;
        const n = findCue(native, t);
        const tr = findCue(translated, t);
        setActiveNative(n);
        setActiveTranslated(tr);
        if (n) lastNativeRef.current = n;
        if (tr) lastTranslatedRef.current = tr;
      }
      const flexy = document.querySelector('ytd-watch-flexy');
      const th = !!flexy?.hasAttribute('theater');
      const fs = !!flexy?.hasAttribute('fullscreen');
      setViewMode((prev) =>
        prev.theater === th && prev.fullscreen === fs ? prev : { theater: th, fullscreen: fs },
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isYouTube, native, translated]);

  // ── Register the MiningSource ──────────────────────────────────
  // The mining modal reads `window.__tokoriMiningSource()` to grab the
  // active cue + <video> at the moment the user clicks "Mine card".
  // Refs ensure the getter always returns the latest state without
  // capturing stale closures (the RAF loop above mutates `activeNative`
  // on every frame).
  const activeNativeRef = useRef(activeNative);
  const activeTranslatedRef = useRef(activeTranslated);
  activeNativeRef.current = activeNative;
  activeTranslatedRef.current = activeTranslated;
  useEffect(() => {
    if (!isYouTube) return;
    const dereg = registerMiningSource((): MiningSource | null => {
      const video = document.querySelector<HTMLVideoElement>('video');
      const native = activeNativeRef.current;
      const translated = activeTranslatedRef.current;
      const detected = native?.text ? detectLanguage(native.text) : null;
      const cueLang = (targetLang || detected) as LanguageCode | null;
      // Title scrape — YT mounts the title under #title h1; fallback to
      // document.title minus " - YouTube" suffix.
      const titleEl = document.querySelector<HTMLElement>('#title h1, h1.title');
      const title =
        titleEl?.innerText?.trim() ||
        document.title.replace(/\s*-\s*YouTube\s*$/, '').trim() ||
        null;
      // Source URL with timestamp fragment so the user can resume.
      const t = video ? Math.floor(video.currentTime) : 0;
      const url = new URL(window.location.href);
      if (t > 0) url.searchParams.set('t', `${t}s`);
      return {
        siteId: 'youtube',
        title,
        sourceUrl: url.toString(),
        currentCue:
          native && cueLang
            ? {
                text: native.text,
                lang: cueLang,
                startSec: native.start,
                endSec: native.start + native.dur,
              }
            : null,
        currentTranslatedCue: translated ? { text: translated.text } : null,
        video,
        requiresLocalOnly: false,
      };
    });
    return dereg;
  }, [isYouTube, targetLang]);

  // ── Drag-anywhere ──────────────────────────────────────────────
  const onContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Allow native interaction on form controls.
      const target = e.target as HTMLElement;
      if (target.closest('select, option, input, textarea')) return;
      e.preventDefault();
      dragRef.current.moved = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const origDx = offset?.dx ?? 0;
      const origDy = offset?.dy ?? 0;

      const onMove = (ev: MouseEvent) => {
        const ddx = ev.clientX - startX;
        const ddy = ev.clientY - startY;
        if (!dragRef.current.moved && Math.hypot(ddx, ddy) > DRAG_THRESHOLD_PX) {
          dragRef.current.moved = true;
        }
        if (dragRef.current.moved) {
          setOffset({ dx: origDx + ddx, dy: origDy + ddy });
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (dragRef.current.moved) {
          // Save the final offset (read latest via ref-ish closure trick).
          // setOffset is sync here; just re-read state on next tick via
          // a microtask. Simpler: read from latestOffsetRef.
          const final = latestOffsetRef.current;
          if (final) {
            try {
              chrome.storage.local.set({ [POS_STORAGE_KEY]: final });
            } catch {}
          }
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [offset],
  );

  // Track latest offset for the mouseup save (avoids stale closure).
  const latestOffsetRef = useRef<DragOffset | null>(offset);
  useEffect(() => {
    latestOffsetRef.current = offset;
  }, [offset]);

  function resetPosition() {
    setOffset(null);
    try {
      chrome.storage.local.remove(POS_STORAGE_KEY);
    } catch {}
  }

  function changeTargetLang(lang: LanguageCode) {
    setTargetLang(lang);
    try {
      chrome.storage.local.set({ [LANG_STORAGE_KEY]: lang });
    } catch {}
    setNative([]);
    setTranslated([]);
    setActiveNative(null);
    setActiveTranslated(null);
    // Also drop the sticky "last cue" memory — keeping the previous
    // language's last line dimmed under a new target language is just
    // confusing (Chinese line still hanging there after switching to ja).
    lastNativeRef.current = null;
    lastTranslatedRef.current = null;
  }

  // Click a character / word — show dict popup *above* the cue so it
  // doesn't disappear off the bottom of the video. Suppressed if a
  // drag happened immediately before.
  const onTokenClick = useCallback(
    (text: string, lang: LanguageCode, evt: React.MouseEvent) => {
      if (dragRef.current.moved) {
        dragRef.current.moved = false;
        return;
      }
      if (selSuppressRef.current) return;
      evt.stopPropagation();
      const rect = (evt.currentTarget as HTMLElement).getBoundingClientRect();
      // Anchor the popup to the left edge of the cue box (not the
      // clicked character) so it lines up visually with the subtitle
      // field, and pass the cue width so the popup can match it.
      const box = nativeBoxRef.current?.getBoundingClientRect();
      const anchorX = box ? box.left : rect.left;
      window.dispatchEvent(
        new CustomEvent('tokori-show-dict', {
          detail: {
            query: text,
            lang,
            anchor: { x: anchorX, y: rect.top },
            placement: 'above',
            width: box?.width ?? nativeBoxWidth ?? undefined,
          },
        }),
      );
    },
    [nativeBoxWidth],
  );

  // Resolve which cue's text should drive the rendered tokens. When the
  // active cue is null (CC off, or just in a between-cue gap) we keep
  // showing the sticky last one — visually dimmed — so the user can
  // still mine words from what was last on screen.
  const cueForTokens = activeNative || lastNativeRef.current;

  // Async tokenizer: jieba on the desktop when paired, Intl.Segmenter
  // fallback. Cued by the cue's `start` so a late HTTP response can't
  // overwrite the rendered tokens for a cue that's already gone by.
  const [nativeTokens, setNativeTokens] = useState<Token[]>([]);
  /** Highlighted token span while drag-selecting (inclusive indices,
   *  unordered — normalise with min/max when consuming). */
  const [selRange, setSelRange] = useState<{ from: number; to: number } | null>(null);
  const nativeTokensRef = useRef<Token[]>([]);
  nativeTokensRef.current = nativeTokens;
  const selRangeRef = useRef(selRange);
  selRangeRef.current = selRange;
  const targetLangRef = useRef(targetLang);
  targetLangRef.current = targetLang;

  // Finish a token drag-select: combine the spanned tokens and show
  // the dict popup for the joined text (names, compounds, phrases the
  // segmenter split apart).
  useEffect(() => {
    const onUp = () => {
      const drag = selDragRef.current;
      if (!drag.active) return;
      drag.active = false;
      const range = selRangeRef.current;
      setSelRange(null);
      if (!drag.moved || !range) return;
      drag.moved = false;
      // The click that follows this mouseup would fire a second,
      // single-token lookup over the popup we're about to open — the
      // click dispatches before timers run, so a 0ms reset is safe.
      selSuppressRef.current = true;
      window.setTimeout(() => {
        selSuppressRef.current = false;
      }, 0);
      const [a, b] = [Math.min(range.from, range.to), Math.max(range.from, range.to)];
      const combined = nativeTokensRef.current
        .slice(a, b + 1)
        .map((t) => t.text)
        .join('')
        .trim();
      if (!combined) return;
      const lang = detectLanguage(combined) || targetLangRef.current;
      if (!lang) return;
      const box = nativeBoxRef.current?.getBoundingClientRect();
      window.dispatchEvent(
        new CustomEvent('tokori-show-dict', {
          detail: {
            query: combined,
            lang,
            anchor: {
              x: box?.left ?? window.innerWidth / 2,
              y: box?.top ?? window.innerHeight / 2,
            },
            placement: 'above',
            width: box?.width ?? undefined,
          },
        }),
      );
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  const tokensCueRef = useRef<number | null>(null);
  const tokenizeCacheRef = useRef<Map<string, Token[]>>(new Map());
  const tokenizerLang = cueForTokens ? detectLanguage(cueForTokens.text) : null;
  useEffect(() => {
    setSelRange(null);
    if (!cueForTokens) {
      setNativeTokens([]);
      return;
    }
    const cueId = cueForTokens.start;
    const text = cueForTokens.text;
    tokensCueRef.current = cueId;

    // Synchronous baseline (per-char CJK / per-word Latin) so the line
    // appears immediately. Replaced by jieba/Segmenter output when it
    // resolves.
    const cacheKey = `${tokenizerLang || 'na'}:${text}`;
    const cached = tokenizeCacheRef.current.get(cacheKey);
    if (cached) {
      setNativeTokens(cached);
      return;
    }
    setNativeTokens(tokenize(text));

    let cancelled = false;
    (async () => {
      const better = await segmentText(text, tokenizerLang);
      if (cancelled) return;
      if (tokensCueRef.current !== cueId) return; // cue rotated
      // Cap the cache so it doesn't grow unbounded over a long session.
      const cache = tokenizeCacheRef.current;
      if (cache.size > 50) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      cache.set(cacheKey, better);
      setNativeTokens(better);
    })();
    return () => {
      cancelled = true;
    };
  }, [cueForTokens, tokenizerLang]);

  // ── Ruby readings for the active cue's tokens ──────────────────
  // One batch request per cue (unique CJK tokens only); the ref cache
  // makes repeated words free across the whole session. `readings`
  // holds the accumulated word → reading map the overlay + sidebar
  // render from. Misses are cached as null so they aren't re-asked.
  const [readings, setReadings] = useState<Map<string, string>>(new Map());
  const readingsCacheRef = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    if (!captionStyle.showReading) return;
    const lang = tokenizerLang || targetLang;
    if (!lang || !getLanguage(lang)?.hasReading) return;
    const wants = [
      ...new Set(
        nativeTokens
          .filter((t) => t.kind === 'word' && CJK_TOKEN_RE.test(t.text))
          .map((t) => t.text),
      ),
    ];
    if (!wants.length) return;
    const cache = readingsCacheRef.current;
    const missing = wants.filter((w) => !cache.has(`${lang}:${w}`));
    const publish = () => {
      setReadings((prev) => {
        const next = new Map(prev);
        for (const w of wants) {
          const r = cache.get(`${lang}:${w}`);
          if (r) next.set(w, r);
        }
        return next.size === prev.size ? prev : next;
      });
    };
    if (!missing.length) {
      publish();
      return;
    }
    let cancelled = false;
    sendMsgAsync<{ readings: Record<string, string | null> }>({
      action: 'dictReadings',
      lang,
      words: missing,
    }).then((res) => {
      if (cancelled || !res.success) return;
      const got = (res as { readings?: Record<string, string | null> }).readings || {};
      for (const w of missing) cache.set(`${lang}:${w}`, got[w] ?? null);
      publish();
    });
    return () => {
      cancelled = true;
    };
  }, [nativeTokens, captionStyle.showReading, tokenizerLang, targetLang]);

  // Re-blur the translated subtitle whenever the cue rotates so the
  // user has to consciously reveal each new line.
  useEffect(() => {
    if (revealedCueStart != null && revealedCueStart !== activeTranslated?.start) {
      setRevealedCueStart(null);
    }
  }, [activeTranslated?.start, revealedCueStart]);

  // Capture the rendered native box width for the popup. ResizeObserver
  // keeps it fresh through theater / fullscreen / player resize.
  useEffect(() => {
    const el = nativeBoxRef.current;
    if (!el) {
      setNativeBoxWidth(null);
      return;
    }
    const ro = new ResizeObserver(() => {
      setNativeBoxWidth(el.getBoundingClientRect().width);
    });
    ro.observe(el);
    setNativeBoxWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [nativeTokens.length]);

  // Early exits.
  if (!isYouTube) return null;
  const onWatchPage = /\/watch/.test(window.location.pathname);
  if (!onWatchPage) return null;
  // Between-cue gaps fall back to the last seen line, shown dimmed.
  // `isLive` distinguishes the two for styling — only a truly active
  // cue gets the "live" treatment. Toggling YouTube's own CC button
  // off hides the overlay entirely; the transcript sidebar is
  // independently controlled and survives the toggle.
  const ccPaused = ccEnabled === false;
  const displayedNative = activeNative || lastNativeRef.current;
  const displayedTranslated = activeTranslated || lastTranslatedRef.current;
  const isLiveNative = !!activeNative;
  const isLiveTranslated = !!activeTranslated;
  // Prefer detection (matches the cue text), but fall back to the user's
  // picked target lang when detection can't tell (Latin-script langs —
  // French, Spanish, German, …). Otherwise the analyzer / dict popup
  // get `lang: null` for European-language cues even though we *know*
  // what the user is studying.
  const lang = (displayedNative ? detectLanguage(displayedNative.text) : null) || targetLang;
  const hasAnyCue = !!(displayedNative || displayedTranslated);
  const overlayVisible = !ccPaused;

  // ── Positioning ────────────────────────────────────────────────
  // Default anchor = bottom-centre of the player, offset 12% up. When
  // the user has dragged we layer `offset.dx/dy` on top.
  const anchorStyle: React.CSSProperties = (() => {
    if (!playerRect) {
      return { left: '50%', bottom: '12%', transform: 'translateX(-50%)' };
    }
    const baseX = playerRect.left + playerRect.width / 2;
    const baseY = playerRect.top + playerRect.height * 0.88; // 12% up from bottom
    const x = baseX + (offset?.dx ?? 0);
    const y = baseY + (offset?.dy ?? 0);
    // Clamp so the overlay never escapes the player bounds.
    const minX = playerRect.left + 80;
    const maxX = playerRect.right - 80;
    const minY = playerRect.top + 30;
    const maxY = playerRect.bottom - 30;
    return {
      left: clamp(x, minX, maxX),
      top: clamp(y, minY, maxY),
      transform: 'translate(-50%, -100%)',
    };
  })();

  return (
    <>
      <CaptionSidebar
        open={sidebarOpen}
        onClose={() => toggleSidebar(false)}
        native={native}
        translated={translated}
        activeStart={activeNative?.start ?? null}
        activeTokens={
          activeNative && cueForTokens && cueForTokens.start === activeNative.start
            ? nativeTokens
            : null
        }
        targetLang={targetLang}
        theater={viewMode.theater}
        fullscreen={viewMode.fullscreen}
        playerRect={playerRect}
        colorFor={(word) =>
          statusColorFor(
            knownWords.get(word),
            captionStyle.highlightUnseen && knownWords.size > 0,
            captionStyle,
          )
        }
        highlightMode={captionStyle.highlightMode}
        showReading={captionStyle.showReading}
        readingFor={(word) => readings.get(word) ?? null}
        onToggleReading={() => patchCaptionStyle({ showReading: !captionStyle.showReading })}
      />
      {overlayVisible && (
        <div
          ref={containerRef}
          className="tk-force-dark"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onMouseDown={onContainerMouseDown}
          style={s({
            position: 'fixed',
            ...anchorStyle,
            maxWidth: playerRect ? `${Math.min(playerRect.width - 40, 1100)}px` : '88vw',
            pointerEvents: 'auto',
            zIndex: '2147483645',
            textAlign: 'center',
            userSelect: 'text',
            cursor: 'grab',
          })}
        >
          {/* Toolbar: target-lang picker + reset. Drag handle removed —
          drag works anywhere now. */}
          <div
            style={s({
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '4px',
              opacity: hovered || !hasAnyCue ? 1 : 0,
              transition: 'opacity 120ms ease',
              pointerEvents: 'auto',
            })}
          >
            <label
              title="Target language for captions"
              style={s({
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '2px 4px 2px 10px',
                fontSize: '11px',
              })}
            >
              <span aria-hidden style={{ opacity: 0.7 }}>
                CC
              </span>
              <select
                value={targetLang ?? ''}
                onChange={(e) => changeTargetLang(e.target.value as LanguageCode)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                style={s({
                  background: 'transparent',
                  color: '#fff',
                  border: 'none',
                  fontSize: '11px',
                  outline: 'none',
                  cursor: 'pointer',
                  padding: '0 2px',
                })}
              >
                {!targetLang && (
                  <option value="" disabled>
                    —
                  </option>
                )}
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} style={{ background: '#111' }}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>

            {offset && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  resetPosition();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Reset position"
                style={s({
                  background: 'rgba(0,0,0,0.7)',
                  color: TOKENS.textMuted,
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '999px',
                  padding: '3px 10px',
                  fontSize: '11px',
                  cursor: 'pointer',
                })}
              >
                Reset
              </button>
            )}

            {(knownWords.size > 0 || knownMeta.error) && (
              <span
                title={
                  knownMeta.error
                    ? `Couldn't load your vocab — ${knownMeta.error}`
                    : `${knownWords.size} words from your Tokori ${knownMeta.source} workspace are highlighted`
                }
                style={s({
                  background: 'rgba(0,0,0,0.5)',
                  color: knownMeta.error ? '#fbbf24' : TOKENS.textMuted,
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '999px',
                  padding: '2px 8px',
                  fontSize: '10px',
                  cursor: knownMeta.error ? 'help' : 'default',
                })}
              >
                {knownMeta.error ? '⚠ vocab' : `${knownWords.size} known`}
              </span>
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                const next = !blurTranslated;
                setBlurTranslated(next);
                if (!next) setRevealedCueStart(null);
                try {
                  chrome.storage.local.set({ [BLUR_TRANSLATED_KEY]: next });
                } catch {}
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title={
                blurTranslated
                  ? 'Translated subtitles are blurred — click to reveal each line'
                  : 'Translated subtitles are always visible'
              }
              style={s({
                background: blurTranslated ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.5)',
                color: blurTranslated ? '#fff' : TOKENS.textMuted,
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: 'pointer',
              })}
            >
              Blur EN: {blurTranslated ? 'on' : 'off'}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                patchCaptionStyle({ showReading: !captionStyle.showReading });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title={
                captionStyle.showReading
                  ? 'Readings (pinyin / furigana) are shown above each word'
                  : 'Show readings (pinyin / furigana) above each word'
              }
              style={s({
                background: captionStyle.showReading ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.5)',
                color: captionStyle.showReading ? '#fff' : TOKENS.textMuted,
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: 'pointer',
              })}
            >
              Pinyin: {captionStyle.showReading ? 'on' : 'off'}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                // Toolbar trigger — no detail; the modal pulls everything
                // from getMiningSource() (active cue + <video>).
                window.dispatchEvent(new CustomEvent('tokori-open-miner'));
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Mine card from current cue"
              aria-label="Mine card from current cue"
              disabled={!displayedNative}
              style={s({
                background: 'rgba(0,0,0,0.7)',
                color: displayedNative ? '#fff' : 'rgba(255,255,255,0.35)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: displayedNative ? 'pointer' : 'not-allowed',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              })}
            >
              <span aria-hidden>⛏</span>
              <span>Mine</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleSidebar(!sidebarOpen);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title={
                sidebarOpen ? 'Hide caption sidebar' : 'Show caption sidebar (full transcript)'
              }
              aria-label="Toggle caption sidebar"
              style={s({
                background: sidebarOpen ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.7)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: 'pointer',
              })}
            >
              ☰ CC
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                setSettingsOpen((o) => !o);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Caption appearance"
              aria-label="Caption appearance"
              style={s({
                background: settingsOpen ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.7)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                width: '24px',
                height: '22px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '13px',
                lineHeight: '1',
                padding: '0',
                cursor: 'pointer',
              })}
            >
              ⚙
            </button>
          </div>

          {settingsOpen && (
            <CaptionSettingsPanel
              style={captionStyle}
              onPatch={patchCaptionStyle}
              onReset={resetCaptionStyle}
              onClose={() => setSettingsOpen(false)}
              haveKnownData={knownWords.size > 0}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
            />
          )}

          {/* Each subtitle box is inline-block (background hugs the text),
              so each gets its own block-level row — otherwise two short
              lines fit side by side and the English ends up NEXT TO the
              native line instead of under it. */}
          {displayedNative && lang && (
            <div>
              <div
                ref={nativeBoxRef}
                style={s({
                  background: isLiveNative ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.55)',
                  color: isLiveNative ? captionStyle.nativeColor : 'rgba(255,255,255,0.6)',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: `${captionStyle.nativeFontSize}px`,
                  // Ruby annotations need taller line boxes or the pinyin
                  // clips into the row above.
                  lineHeight:
                    captionStyle.showReading && nativeTokens.some((t) => readings.has(t.text))
                      ? '1.9'
                      : '1.45',
                  marginBottom: '4px',
                  display: 'inline-block',
                  maxWidth: '100%',
                  wordBreak: 'break-word',
                  transition: 'opacity 200ms ease, color 200ms ease, background 200ms ease',
                })}
              >
                {nativeTokens.map((tok, i) => {
                  if (tok.kind === 'space') return <span key={i}>{tok.text}</span>;
                  const status = knownWords.get(tok.text);
                  const ruby = captionStyle.showReading ? readings.get(tok.text) : undefined;
                  // Only paint unseen words when we actually have a known-words
                  // map to compare against — otherwise an unpaired user would
                  // see every word marked red, which is misleading.
                  const haveKnownData = knownWords.size > 0;
                  const color = statusColorFor(
                    status,
                    captionStyle.highlightUnseen && haveKnownData,
                    captionStyle,
                  );
                  const inSel =
                    !!selRange &&
                    i >= Math.min(selRange.from, selRange.to) &&
                    i <= Math.max(selRange.from, selRange.to);
                  return (
                    <span
                      key={i}
                      onClick={(e) => onTokenClick(tok.text, lang, e)}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        // Suppress native text selection — the token
                        // drag-select below replaces it.
                        e.preventDefault();
                        selDragRef.current = { active: true, from: i, moved: false };
                      }}
                      onMouseEnter={() => {
                        const drag = selDragRef.current;
                        if (!drag.active) return;
                        if (i !== drag.from) drag.moved = true;
                        setSelRange({ from: drag.from, to: i });
                      }}
                      style={s({
                        display: 'inline-block',
                        cursor: 'pointer',
                        padding: '0 1px',
                        borderRadius: '3px',
                        background: inSel ? 'rgba(96,165,250,0.4)' : 'transparent',
                        ...(color
                          ? captionStyle.highlightMode === 'text'
                            ? { color }
                            : {
                                textDecoration: 'underline',
                                textDecorationThickness: '2px',
                                textUnderlineOffset: '4px',
                                textDecorationColor: color,
                              }
                          : {}),
                      })}
                    >
                      {ruby ? <RubyWord word={tok.text} reading={ruby} lang={lang} /> : tok.text}
                    </span>
                  );
                })}
                <span
                  title="Open analyzer"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.dispatchEvent(
                      new CustomEvent('tokori-open-analyzer', {
                        detail: {
                          text: displayedNative.text,
                          lang,
                          // Full cue list + position → the analyzer's ‹ ›
                          // pager can walk subtitle lines and seek along.
                          cues: native.map((c) => ({ text: c.text, start: c.start })),
                          index: native.findIndex((c) => c.start === displayedNative.start),
                        },
                      }),
                    );
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={s({
                    marginLeft: '8px',
                    color: TOKENS.accent,
                    fontSize: '12px',
                    cursor: 'pointer',
                    verticalAlign: 'middle',
                  })}
                >
                  analyze
                </span>
              </div>
            </div>
          )}
          {/* Translated line — rendered ONLY when the native line above is
              present, so the English always sits underneath the target-
              language subtitle and never appears alone in its place
              (track timings can briefly produce a translated cue with no
              matching native one). */}
          {displayedTranslated &&
            displayedNative &&
            (() => {
              const isRevealed =
                !blurTranslated ||
                (isLiveTranslated && revealedCueStart === activeTranslated?.start);
              return (
                <div>
                  <div
                    title={
                      blurTranslated && !isRevealed ? 'Click to reveal translation' : undefined
                    }
                    onClick={(e) => {
                      if (!blurTranslated || !isLiveTranslated) return;
                      e.stopPropagation();
                      setRevealedCueStart(activeTranslated?.start ?? null);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={s({
                      background: isLiveTranslated ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.45)',
                      color: isLiveTranslated
                        ? captionStyle.translatedColor
                        : 'rgba(245,245,245,0.65)',
                      padding: '5px 12px',
                      borderRadius: '6px',
                      fontSize: `${captionStyle.translatedFontSize}px`,
                      fontWeight: 500,
                      textShadow: isLiveTranslated ? '0 1px 2px rgba(0,0,0,0.55)' : 'none',
                      display: 'inline-block',
                      maxWidth: '100%',
                      cursor: blurTranslated && !isRevealed ? 'pointer' : 'default',
                      filter: isRevealed ? 'none' : 'blur(6px)',
                      transition: 'filter 180ms ease, color 200ms ease, background 200ms ease',
                      userSelect: isRevealed ? 'text' : 'none',
                    })}
                  >
                    {displayedTranslated.text}
                  </div>
                </div>
              );
            })()}
        </div>
      )}
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function findCue(cues: Cue[], t: number): Cue | null {
  for (const c of cues) {
    if (t >= c.start && t < c.start + c.dur) return c;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Caption tokeniser (Token, tokenize, segmentText) now lives in
// ./youtube/caption-tokenize.
