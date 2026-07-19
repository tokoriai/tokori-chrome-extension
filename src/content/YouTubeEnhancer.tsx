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
 *   • The Subtitle-source menu lives in the toolbar. Auto only engages
 *     when the video actually has a target-language caption track —
 *     otherwise the extension stays hands-off (YouTube's own captions
 *     run untouched) and the toolbar shows a "No <lang> CC" hint; see
 *     youtube-cues.ts / lib/yt-track-pick for the selection ladder.
 */

import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { TOKENS, s } from '../lib/theme';
import { detectLanguage, getLanguage, type LanguageCode } from '../lib/languages';
import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { type Token, tokenize, segmentText } from './youtube/caption-tokenize';
import { CaptionSidebar } from './youtube/CaptionSidebar';
import { RubyWord } from './RubyWord';
import { DEFAULT_CAPTION_STYLE, statusColorFor, type CaptionStyle } from './youtube/caption-style';
import { CaptionSettingsPanel } from './youtube/CaptionSettingsPanel';
import { registerMiningSource, type MiningSource } from '../lib/mining/source';
import type { Settings } from '../lib/settings';
import { useImmersionTimer } from './youtube/useImmersion';
import { isShortsPage, ytPageVideoId, ytPlayerEl, ytVideoSelector } from './youtube/player-el';
import { useOcrCues } from './ocr/useOcrCues';
import { OcrRegionSelector } from './ocr/OcrRegionSelector';
import { DEFAULT_OCR_REGION, normalizeOcrRegion, type OcrRegion } from '../lib/ocr-cues';
import { formatTimer } from '../lib/immersion';

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
/** OCR mode gets its own drag offset — its bar sits opposite the
 *  capture region by default (usually the TOP of the player, clear of
 *  the burned-in text), and dragging it there must not relocate the
 *  normal caption overlay. */
const OCR_POS_STORAGE_KEY = 'youtubeCaptionOffsetOcr';
/** User-drawn OCR capture region (frame fractions). */
const OCR_REGION_KEY = 'youtubeOcrRegion';
/** Retired: the toolbar's per-video CC language picker persisted here.
 *  Removed from storage on mount so it can never shadow the settings
 *  value (Options → General) again. */
const LEGACY_LANG_STORAGE_KEY = 'youtubeTargetLang';
/** Legacy boolean (blur on/off) — migrated into EN_MODE_KEY below. */
const BLUR_TRANSLATED_KEY = 'youtubeBlurTranslated';
/** 'show' | 'blur' | 'off' — the EN line's display mode. */
const EN_MODE_KEY = 'youtubeEnMode';
const STYLE_STORAGE_KEY = 'youtubeCaptionStyle';
const SIDEBAR_OPEN_KEY = 'youtubeSidebarOpen';
const NATIVE_CC_HIDE_STYLE_ID = 'tokori-yt-hide-native-cc';
const DRAG_THRESHOLD_PX = 4;

/** Rough Han / kana test — only tokens containing these scripts get a
 *  ruby reading lookup; Latin words inside a zh/ja cue never will. */
const CJK_TOKEN_RE = /[㐀-鿿豈-﫿぀-ヿ]/;

/** Stable empty cue list for the EN-off mode (identity matters — the
 *  RAF loop re-arms on cue-list changes). */
const NO_CUES: Cue[] = [];

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
  /** Shorts page (`/shorts/<id>`) — the player is `#shorts-player`, a
   *  narrow portrait box, and there's no `#secondary` column for the
   *  sidebar to dock into. Tracked as state (updated by the RAF loop)
   *  so SPA navigation between watch and Shorts re-scopes everything. */
  const [isShorts, setIsShorts] = useState(false);
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
  /** The EN (display-language) line, user-controlled and persisted:
   *   • 'blur' — rendered blurred, click to reveal (default: forces
   *              native-first reading).
   *   • 'show' — always readable.
   *   • 'off'  — no EN line AT ALL: nothing rendered, no translate
   *              calls in OCR mode, and the MAIN world skips the
   *              translated-track hunting entirely. */
  const [enMode, setEnMode] = useState<'show' | 'blur' | 'off'>('blur');
  const blurTranslated = enMode === 'blur';
  /** Caption styling (font sizes + colours). Tweakable from the gear
   *  icon; persisted under STYLE_STORAGE_KEY. */
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Watch-list wiring: the canonical URL of the current watch page
   *  and whether it's on the paired desktop's Immersion list. 'hidden'
   *  = unpaired desktop / no watch page — no dead affordance. */
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const [listState, setListState] = useState<'hidden' | 'out' | 'busy' | 'in'>('hidden');
  const [listError, setListError] = useState<string | null>(null);
  /** Immersion timer (study mode) — explicit start via the ⏱ pill;
   *  accrues only while a LIBRARY video actually plays (the second arg
   *  gates accrual on the watch-list lookup). See useImmersion.ts.
   *  A session ended from the desktop sidebar counts as a manual stop
   *  for THIS video, so the listed-video auto-start below doesn't
   *  immediately resurrect what the user just ended. Declared here
   *  (not at the toggle) because the remote-end callback writes it. */
  const manualStopUrlRef = useRef<string | null>(null);
  const watchUrlRef = useRef<string | null>(null);
  watchUrlRef.current = watchUrl;
  const onRemoteEnd = useCallback(() => {
    manualStopUrlRef.current = watchUrlRef.current;
  }, []);
  const immersion = useImmersionTimer(isYouTube, listState === 'in', onRemoteEnd);
  /** Timer running but the current video isn't on the library — the
   *  session is alive, just not counting. Drives the pill hint. */
  const timerIdle = immersion.active && listState !== 'in';
  /** Session alive but paused (video paused, or paused from the
   *  desktop sidebar) — frozen clock, amber pill. */
  const timerPaused = immersion.active && !timerIdle && immersion.paused;
  /** This video's caption tracks + auto-translate languages (published
   *  by the MAIN-world script) — feeds the YouTube-CC-menu-style
   *  subtitle select next to the language picker. */
  const [ccTracks, setCcTracks] = useState<{
    tracks: { vssId: string; languageCode: string; kind: string; label: string }[];
    translations: { code: string; name: string }[];
  }>({ tracks: [], translations: [] });
  /** 'auto' | 'track:<vssId>' | 'tlang:<code>' | 'ocr' — mirrors the
   *  MAIN world's native-line override (reset to auto on navigation).
   *  'ocr' suspends the MAIN world entirely and reads burned-in
   *  subtitles off the frame instead. */
  const [trackChoice, setTrackChoice] = useState('auto');
  /** False once the MAIN world reports it is standing down on this
   *  video (`tokori-yt-track-status`, engaged:false — no caption track
   *  in the target language). Auto then leaves YouTube's captions
   *  alone: the toolbar stops pinning itself as "loading" and shows a
   *  hint instead. Any user pick (or new video / target) re-engages. */
  const [autoEngaged, setAutoEngaged] = useState(true);
  const lastTracksVideoRef = useRef('');
  /** Latest tracks, readable synchronously from event handlers — the
   *  `tokori-yt-tracks` and `tokori-yt-auto-pick` events land in the
   *  same task, before React commits the state update above. */
  const ccTracksRef = useRef(ccTracks);
  /** True while `trackChoice` is the automatic pick or a reflection of
   *  it (not a user pin) — only then may `tokori-yt-auto-pick` move the
   *  Subtitle select. A ref for the same same-task reason. */
  const trackAdoptableRef = useRef(true);
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
  /** The player has no usable CC control at all (video without caption
   *  tracks — the OCR mode's home turf). The toolbar then reveals on
   *  hover only, instead of floating permanently over every video. */
  const [ccAbsent, setCcAbsent] = useState(false);
  /** Brief toolbar pin after the MAIN world announces hands-off (no
   *  target-language track): without it the only trace of the
   *  extension on out-of-language videos is a hover-revealed bar,
   *  which reads as "stopped working". Armed by onTrackStatus. */
  const [autoIdleFlash, setAutoIdleFlash] = useState(false);
  const idleFlashTimerRef = useRef<number | null>(null);
  /** Burned-in subtitle capture (player-bar OCR button / Subtitle menu
   *  → OCR). While it owns the overlay, the cue lists below come from
   *  frame OCR instead of the timedtext streams. Deliberately NOT
   *  gated on YouTube's CC button — burned-subs videos are exactly
   *  where the user keeps YT captions off. */
  const ocrMode = trackChoice === 'ocr';
  /** Where on the frame to read. `null` until the user has ever drawn
   *  one — that first enable auto-opens the region selector. */
  const [ocrRegion, setOcrRegion] = useState<OcrRegion | null>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  /** OCR-mode drag offset (separate persistence — see the key above). */
  const [ocrOffset, setOcrOffset] = useState<DragOffset | null>(null);
  /** Active player's <video> — `#shorts-player video` on Shorts. State
   *  (not a live query) so hooks taking a selector re-arm on SPA
   *  navigation between the two page types. */
  const videoSel = isShorts ? '#shorts-player video' : '#movie_player video';
  const ocr = useOcrCues(
    isYouTube && ocrMode,
    targetLang,
    ocrRegion ?? DEFAULT_OCR_REGION,
    enMode !== 'off',
    videoSel,
  );
  const nativeCues = ocrMode ? ocr.native : native;
  // EN off hides the translated stream EVERYWHERE (overlay line, RAF
  // actives, sidebar, mining) while keeping the loaded cues in state —
  // flipping back on is instant. Stable [] so effects keyed on the
  // list don't re-arm each render.
  const translatedCues = enMode === 'off' ? NO_CUES : ocrMode ? ocr.translated : translated;

  const saveOcrRegion = (r: OcrRegion) => {
    setOcrRegion(r);
    setSelectingRegion(false);
    try {
      chrome.storage.local.set({ [OCR_REGION_KEY]: r });
    } catch {}
  };

  // First-ever OCR enable: ask WHERE the subtitles are before burning
  // vision calls on the wrong strip. Esc keeps the default bottom
  // strip for this session; the ⛶ Region chip reopens the selector.
  useEffect(() => {
    if (ocrMode && ocrRegion === null) setSelectingRegion(true);
    if (!ocrMode) setSelectingRegion(false);
  }, [ocrMode, ocrRegion]);
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
  // The target language comes from the extension settings (Options →
  // General; onboarding sets it from the paired workspace). There is
  // deliberately no per-video language picker anymore — the Subtitle menu
  // (the video's own caption tracks) is the only caption-source
  // control, and the auto pick + dictionary follow the settings value.
  useEffect(() => {
    if (!isYouTube) return;
    try {
      chrome.storage.local.get([POS_STORAGE_KEY, OCR_POS_STORAGE_KEY, OCR_REGION_KEY], (r) => {
        const p = r[POS_STORAGE_KEY] as DragOffset | undefined;
        if (p && Number.isFinite(p.dx) && Number.isFinite(p.dy)) setOffset(p);
        const po = r[OCR_POS_STORAGE_KEY] as DragOffset | undefined;
        if (po && Number.isFinite(po.dx) && Number.isFinite(po.dy)) setOcrOffset(po);
        if (r[OCR_REGION_KEY]) setOcrRegion(normalizeOcrRegion(r[OCR_REGION_KEY]));
      });
      // One-time cleanup: the retired toolbar picker used to shadow the
      // settings value through this key.
      chrome.storage.local.remove(LEGACY_LANG_STORAGE_KEY);
      sendMsg<{ data: { defaultTargetLang: LanguageCode } }>({ action: 'getSettings' }, (res) => {
        if (res?.success) {
          const lang = (res as { data?: { defaultTargetLang?: LanguageCode } }).data
            ?.defaultTargetLang;
          if (lang) applyTargetLang(lang);
        }
      });
      // Settings are a flat spread in chrome.storage.local, so an
      // Options change surfaces here — open YouTube tabs follow along
      // without a reload.
      const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
        if (area !== 'local' || !('defaultTargetLang' in changes)) return;
        const lang = changes.defaultTargetLang?.newValue as LanguageCode | undefined;
        if (lang) applyTargetLang(lang);
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
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
    // Slow safety-net poll only: real updates arrive as the window
    // event below (relayed from the background's storage-snapshot push
    // by content/index.tsx), and each poll is answered from the
    // worker's in-memory map without a network hit anyway.
    const t = window.setInterval(loadKnown, 300_000);
    // Fired by the dict popup right after a status grade / save — and
    // by the storage push relay — so caption colours update
    // immediately instead of on the next poll.
    const onChanged = () => void loadKnown();
    window.addEventListener('tokori-known-words-changed', onChanged);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener('tokori-known-words-changed', onChanged);
    };
  }, [isYouTube]);

  // ── Persisted EN-line mode ─────────────────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    try {
      chrome.storage.local.get([EN_MODE_KEY, BLUR_TRANSLATED_KEY, SIDEBAR_OPEN_KEY], (r) => {
        const mode = r[EN_MODE_KEY];
        if (mode === 'show' || mode === 'blur' || mode === 'off') {
          setEnMode(mode);
        } else if (typeof r[BLUR_TRANSLATED_KEY] === 'boolean') {
          // Migrate the old blur on/off boolean.
          setEnMode(r[BLUR_TRANSLATED_KEY] ? 'blur' : 'show');
        }
        if (typeof r[SIDEBAR_OPEN_KEY] === 'boolean') setSidebarOpen(r[SIDEBAR_OPEN_KEY]);
      });
    } catch {
      /* extension context invalidated — keep default */
    }
  }, [isYouTube]);

  const cycleEnMode = () => {
    const next = enMode === 'show' ? 'blur' : enMode === 'blur' ? 'off' : 'show';
    setEnMode(next);
    if (next !== 'blur') setRevealedCueStart(null);
    try {
      chrome.storage.local.set({ [EN_MODE_KEY]: next });
    } catch {}
  };

  // Tell the MAIN world whether to hunt the translated track at all —
  // EN off skips its excursions (the flicker-prone, fetch-heavy part).
  useEffect(() => {
    if (!isYouTube) return;
    window.dispatchEvent(
      new CustomEvent('tokori-yt-set-translation', { detail: { enabled: enMode !== 'off' } }),
    );
  }, [isYouTube, enMode]);

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
    const haveCues = nativeCues.length > 0 || translatedCues.length > 0;
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
  }, [isYouTube, nativeCues.length, translatedCues.length, ccEnabled]);

  // ── Cue ingest + CC-state mirror ───────────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    // Cue events are stamped with the video id they were captured for —
    // ignore any that don't match the page we're on (a dispatch racing
    // a navigation). The MAIN world already drops mismatched responses;
    // this guards the listener side of the same race.
    const cuesMatchPage = (videoId: string | undefined) => {
      const cur = ytPageVideoId();
      return !videoId || !cur || videoId === cur;
    };
    const onNative = (e: Event) => {
      const ce = e as CustomEvent<{ cues: Cue[]; videoId?: string }>;
      if (ce.detail?.cues && cuesMatchPage(ce.detail.videoId)) {
        setNative(ce.detail.cues);
        // Native cues flowing = the MAIN world owns this video after all.
        setAutoEngaged(true);
        setAutoIdleFlash(false);
      }
    };
    const onTranslated = (e: Event) => {
      const ce = e as CustomEvent<{ cues: Cue[]; videoId?: string }>;
      if (ce.detail?.cues && cuesMatchPage(ce.detail.videoId)) setTranslated(ce.detail.cues);
    };
    const onCcState = (e: Event) => {
      const ce = e as CustomEvent<{ enabled: boolean; absent?: boolean }>;
      setCcEnabled(!!ce.detail?.enabled);
      setCcAbsent(!!ce.detail?.absent);
    };
    // The MAIN world stood down (no target-language track): drop any
    // cue state that slipped in before the verdict, so the overlay
    // never hides YouTube's own captions while rendering nothing.
    const onTrackStatus = (e: Event) => {
      const ce = e as CustomEvent<{ videoId?: string; engaged?: boolean }>;
      if (!cuesMatchPage(ce.detail?.videoId) || ce.detail?.engaged !== false) return;
      setAutoEngaged(false);
      setNative([]);
      setTranslated([]);
      setActiveNative(null);
      setActiveTranslated(null);
      lastNativeRef.current = null;
      lastTranslatedRef.current = null;
      // Surface the verdict: pin the toolbar for a few seconds so the
      // "No {lang} CC" pill and the Subtitle menu are seen, then fall
      // back to hover-reveal.
      setAutoIdleFlash(true);
      if (idleFlashTimerRef.current) window.clearTimeout(idleFlashTimerRef.current);
      idleFlashTimerRef.current = window.setTimeout(() => setAutoIdleFlash(false), 6000);
    };
    const onTracks = (e: Event) => {
      const ce = e as CustomEvent<{
        videoId?: string;
        tracks?: { vssId: string; languageCode: string; kind: string; label: string }[];
        translationLanguages?: { code: string; name: string }[];
      }>;
      const next = {
        tracks: ce.detail?.tracks || [],
        translations: ce.detail?.translationLanguages || [],
      };
      ccTracksRef.current = next;
      setCcTracks(next);
      // New video → the MAIN world reset its override to auto; mirror
      // that here so the select doesn't claim a pin that's gone.
      const vid = ce.detail?.videoId || '';
      if (vid && vid !== lastTracksVideoRef.current) {
        lastTracksVideoRef.current = vid;
        setTrackChoice('auto');
        trackAdoptableRef.current = true;
      }
    };
    // The automatic pick resolved (target-language track, zh script
    // handling, auto-translate fallback) — land the Subtitle select on
    // that entry so it reads "Japanese (auto-generated)" instead of
    // "Auto". Display-only: no pin is dispatched, so the MAIN world
    // keeps its auto-mode fallbacks. Skipped while the user holds an
    // explicit pin (or OCR).
    const onAutoPick = (e: Event) => {
      const ce = e as CustomEvent<{ videoId?: string; value?: string }>;
      const value = ce.detail?.value || '';
      if (!value || !cuesMatchPage(ce.detail?.videoId) || !trackAdoptableRef.current) return;
      // Only reflect entries the menu actually offers — an unlisted
      // value would render the select blank.
      const { tracks, translations } = ccTracksRef.current;
      const listed = value.startsWith('tlang:')
        ? translations.some((l) => `tlang:${l.code}` === value)
        : tracks.some((t) => `track:${t.vssId}` === value);
      if (listed) setTrackChoice(value);
    };
    // The user picked a track / auto-translate language in YOUTUBE's own
    // subtitles menu and the MAIN world adopted it as a pin. Follow it
    // like a pick from our menu, minus the set-track echo: move the
    // select, mark it a user pin, and clear cue state so the new source
    // repopulates cleanly (the fresh selection round refetches it).
    const onExternalPick = (e: Event) => {
      const ce = e as CustomEvent<{ videoId?: string; value?: string }>;
      const value = ce.detail?.value || '';
      if (!value || !cuesMatchPage(ce.detail?.videoId)) return;
      const { tracks, translations } = ccTracksRef.current;
      const listed = value.startsWith('tlang:')
        ? translations.some((l) => `tlang:${l.code}` === value)
        : tracks.some((t) => `track:${t.vssId}` === value);
      if (!listed) return;
      trackAdoptableRef.current = false;
      setTrackChoice(value);
      setNative([]);
      setTranslated([]);
      setActiveNative(null);
      setActiveTranslated(null);
      lastNativeRef.current = null;
      lastTranslatedRef.current = null;
    };
    window.addEventListener('tokori-yt-native-cues', onNative as EventListener);
    window.addEventListener('tokori-yt-translated-cues', onTranslated as EventListener);
    window.addEventListener('tokori-yt-cc-state', onCcState as EventListener);
    window.addEventListener('tokori-yt-track-status', onTrackStatus as EventListener);
    window.addEventListener('tokori-yt-tracks', onTracks as EventListener);
    window.addEventListener('tokori-yt-auto-pick', onAutoPick as EventListener);
    window.addEventListener('tokori-yt-external-pick', onExternalPick as EventListener);
    // The MAIN-world script runs at document_start and may have already
    // captured + dispatched this video's tracks / cues before these
    // listeners existed (this component mounts at document_idle, after a
    // React commit). Ask it to re-serve whatever it has, so a caption
    // round that finished early isn't lost to "sometimes no subtitles".
    window.dispatchEvent(new CustomEvent('tokori-yt-request-replay'));
    return () => {
      window.removeEventListener('tokori-yt-native-cues', onNative as EventListener);
      window.removeEventListener('tokori-yt-translated-cues', onTranslated as EventListener);
      window.removeEventListener('tokori-yt-cc-state', onCcState as EventListener);
      window.removeEventListener('tokori-yt-track-status', onTrackStatus as EventListener);
      window.removeEventListener('tokori-yt-tracks', onTracks as EventListener);
      window.removeEventListener('tokori-yt-auto-pick', onAutoPick as EventListener);
      window.removeEventListener('tokori-yt-external-pick', onExternalPick as EventListener);
    };
  }, [isYouTube]);

  // ── RAF loop: active cue + player rect ─────────────────────────
  useEffect(() => {
    if (!isYouTube) return;
    const tick = () => {
      // Scoped to the active player — Shorts pages keep preloaded
      // prev/next reel <video>s around, and a bare 'video' query (or
      // the hidden #movie_player left over from a watch navigation)
      // would read the wrong element.
      const video = document.querySelector<HTMLVideoElement>(ytVideoSelector());
      const player = ytPlayerEl();
      const rectSource = player || video;
      const shorts = isShortsPage();
      setIsShorts((prev) => (prev === shorts ? prev : shorts));
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
        const n = findCue(nativeCues, t);
        const tr = findCue(translatedCues, t);
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
  }, [isYouTube, nativeCues, translatedCues]);

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
      const video = document.querySelector<HTMLVideoElement>(ytVideoSelector());
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

  // Watch-list state for the current video: recompute the canonical
  // watch URL on SPA navigation, then probe the paired desktop's
  // Immersion list ("is this queued?") to badge the toolbar. Unpaired
  // or non-watch pages keep the button hidden.
  useEffect(() => {
    if (!isYouTube) return;
    const compute = () => {
      const v = new URL(window.location.href).searchParams.get('v');
      setWatchUrl((prev) => {
        const next = v ? `https://www.youtube.com/watch?v=${v}` : null;
        return prev === next ? prev : next;
      });
    };
    compute();
    // yt-navigate-finish is the fast path; the 1 s poll catches
    // navigations where the event is missed (same fallback the
    // MAIN-world cue script uses).
    const timer = window.setInterval(compute, 1000);
    window.addEventListener('yt-navigate-finish', compute);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('yt-navigate-finish', compute);
    };
  }, [isYouTube]);

  // ── Video-change reset ─────────────────────────────────────────
  // The enhancer stays mounted across YouTube's SPA navigation, so a
  // video switch must explicitly drop the previous video's captions —
  // otherwise the RAF loop keeps matching the OLD transcript against
  // the NEW video's clock until fresh cues arrive (or forever, when
  // the new video has none). Only a real id→id change clears: going
  // watch → home → back to the same video keeps the cues, because the
  // MAIN world's once-flags still stand for that video and it won't
  // re-dispatch them.
  const lastVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    const vid = watchUrl ? new URL(watchUrl).searchParams.get('v') : null;
    if (!vid) return;
    if (lastVideoIdRef.current !== null && lastVideoIdRef.current !== vid) {
      setNative([]);
      setTranslated([]);
      setActiveNative(null);
      setActiveTranslated(null);
      lastNativeRef.current = null;
      lastTranslatedRef.current = null;
      setRevealedCueStart(null);
      // The subtitle menu belongs to the previous video too — it
      // refills from the fresh `tokori-yt-tracks` publish.
      setCcTracks({ tracks: [], translations: [] });
      ccTracksRef.current = { tracks: [], translations: [] };
      setTrackChoice('auto');
      trackAdoptableRef.current = true;
      // Fresh video, fresh verdict — the MAIN world re-announces
      // hands-off if the new video lacks the target language too.
      setAutoEngaged(true);
    }
    lastVideoIdRef.current = vid;
  }, [watchUrl]);

  useEffect(() => {
    if (!watchUrl) {
      setListState('hidden');
      return;
    }
    let cancelled = false;
    setListState('hidden');
    setListError(null);
    sendMsg({ action: 'mediaLookup', url: watchUrl }, (res) => {
      if (cancelled) return;
      const r = res as unknown as { success?: boolean; matched?: boolean } | undefined;
      if (r?.success) setListState(r.matched ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
    };
  }, [watchUrl]);

  const addToWatchList = useCallback(() => {
    if (!watchUrl || listState === 'busy' || listState === 'in') return;
    setListState('busy');
    setListError(null);
    const video = document.querySelector<HTMLVideoElement>(ytVideoSelector());
    sendMsg(
      {
        action: 'sendLibraryItem',
        kind: 'video',
        title:
          document.querySelector<HTMLElement>('#title h1, h1.title')?.innerText?.trim() ||
          document.title.replace(/\s*-\s*YouTube\s*$/, '').trim(),
        url: watchUrl,
        durationSec:
          video && Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
        channel: scrapeChannelName(),
      },
      (res) => {
        const r = res as unknown as { success?: boolean; error?: string } | undefined;
        if (r?.success) {
          setListState('in');
        } else {
          setListState('out');
          setListError(r?.error || 'Could not reach Tokori.');
        }
      },
    );
  }, [watchUrl, listState]);

  /** Timer toggle that remembers a manual stop, so the listed-video
   *  auto-start below doesn't immediately restart what the user just
   *  turned off. Navigating to another video clears the suppression.
   *  (`manualStopUrlRef` lives up by the immersion hook — the desktop
   *  remote-end callback shares it.) */
  const toggleTimer = useCallback(() => {
    manualStopUrlRef.current = immersion.active ? watchUrl : null;
    immersion.toggle();
  }, [immersion, watchUrl]);

  // Auto-start the immersion timer when the current video is on the
  // watch library (listState 'in' covers both the paired desktop and
  // the in-browser store). Adding the video to the list was the
  // opt-in; the timer — and with it progress tracking — then takes
  // care of itself. Guarded per-URL so it fires once per video, and
  // suppressed after a manual stop on the same video.
  const autoStartedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (listState !== 'in' || !watchUrl || immersion.active) return;
    if (autoStartedUrlRef.current === watchUrl) return;
    if (manualStopUrlRef.current === watchUrl) return;
    let cancelled = false;
    sendMsg({ action: 'getSettings' }, (res) => {
      if (cancelled || !res?.success) return;
      const s = (res as unknown as { data?: Settings }).data;
      if (s?.immersion?.autoStartListed === false) return;
      if (autoStartedUrlRef.current === watchUrl || manualStopUrlRef.current === watchUrl) return;
      autoStartedUrlRef.current = watchUrl;
      immersion.toggle();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listState, watchUrl, immersion.active]);

  // ── Native action-bar buttons (next to like / Share) ─────────────
  //
  // A host container is appended into YouTube's own actions row and
  // the buttons render into it through a portal, so they live in the
  // page layout (always visible) while their state stays in this
  // component. YT rebuilds that row on SPA navigation and on layout
  // experiments — the attach loop re-finds/re-creates the container
  // instead of assuming it survives.
  const [actionBarEl, setActionBarEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!isYouTube) return;
    let cancelled = false;
    const ensure = () => {
      if (cancelled) return;
      if (!/[?&]v=/.test(window.location.search)) {
        setActionBarEl(null);
        return;
      }
      const host =
        document.querySelector<HTMLElement>(
          'ytd-watch-metadata #actions #top-level-buttons-computed',
        ) ?? document.querySelector<HTMLElement>('#actions #top-level-buttons-computed');
      if (!host) {
        setActionBarEl(null);
        return;
      }
      let el = host.querySelector<HTMLElement>(':scope > #tokori-yt-actions');
      if (!el) {
        el = document.createElement('div');
        el.id = 'tokori-yt-actions';
        el.style.display = 'inline-flex';
        el.style.alignItems = 'center';
        el.style.gap = '8px';
        el.style.marginLeft = '8px';
        host.appendChild(el);
      }
      setActionBarEl((prev) => (prev === el ? prev : el));
    };
    ensure();
    const timer = window.setInterval(ensure, 1500);
    window.addEventListener('yt-navigate-finish', ensure);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('yt-navigate-finish', ensure);
      document.getElementById('tokori-yt-actions')?.remove();
      setActionBarEl(null);
    };
  }, [isYouTube]);

  // ── Player-bar OCR button (next to YouTube's own CC button) ─────
  //
  // A native-looking `.ytp-button` in the player controls toggles OCR
  // mode — the discoverable entry point the Subtitle menu option can't
  // be (the toolbar hides on caption-less videos until hovered). YT
  // rebuilds the control bar on navigation, so the attach loop
  // re-creates the button rather than assuming it survives.
  const trackChoiceRef = useRef(trackChoice);
  trackChoiceRef.current = trackChoice;
  const changeTrackChoiceRef = useRef<(v: string) => void>(() => {});
  changeTrackChoiceRef.current = changeTrackChoice;
  useEffect(() => {
    if (!isYouTube) return;
    let cancelled = false;
    const syncStyle = (btn: HTMLButtonElement) => {
      const on = trackChoiceRef.current === 'ocr';
      btn.setAttribute('aria-pressed', String(on));
      // Mimic the red underline YT's CC button shows while pressed.
      btn.style.boxShadow = on ? 'inset 0 -3px 0 #f00' : 'none';
      btn.style.opacity = on ? '1' : '0.85';
      btn.title = on
        ? 'Tokori OCR captions: on — reading burned-in subtitles (click to turn off)'
        : 'Tokori OCR captions: read burned-in (hardcoded) subtitles — local model or AI key (Options → AI)';
    };
    const ensure = () => {
      if (cancelled) return;
      // A control bar mid-rebuild or an unexpected layout variant must
      // never throw out of this effect — the first call runs inside
      // the React commit, and an exception there unmounts the WHOLE
      // extension tree on the page. The 1.5 s tick simply retries.
      try {
        const existing = document.getElementById('tokori-ocr-ytp-btn') as HTMLButtonElement | null;
        // Player pages only: /watch?v=… and the /live/<id> path live
        // streams are opened under (no ?v= there — the old search-only
        // gate silently kept the button off every live stream). Home /
        // browse pages keep an inline preview #movie_player around, so
        // the gate can't just be "a player exists".
        if (!/[?&]v=/.test(window.location.search) && !/^\/live\//.test(window.location.pathname)) {
          existing?.remove();
          return;
        }
        const controls = document.querySelector<HTMLElement>('#movie_player .ytp-right-controls');
        if (!controls) return;
        let btn = existing;
        if (!btn || !controls.contains(btn)) {
          btn?.remove();
          btn = document.createElement('button');
          btn.id = 'tokori-ocr-ytp-btn';
          btn.className = 'ytp-button';
          btn.textContent = 'OCR';
          btn.setAttribute('aria-label', 'Tokori OCR captions');
          // Text-only button among YT's SVG icon buttons: left to the
          // inline-block baseline (and the control bar's inherited
          // line-height) the label sits visibly off the row. Flex-center
          // the label and pin the box to the line top — every
          // .ytp-button is full-height, so top means flush.
          btn.style.cssText =
            'display:inline-flex;align-items:center;justify-content:center;' +
            'vertical-align:top;line-height:normal;' +
            'font-size:12px;font-weight:700;letter-spacing:0.5px;';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            changeTrackChoiceRef.current(trackChoiceRef.current === 'ocr' ? 'auto' : 'ocr');
          });
          // Right beside the CC button when it exists (even hidden),
          // else lead the right-hand control cluster. Some YT layouts
          // nest the CC button inside a wrapper — insertBefore needs a
          // DIRECT child of `controls`, so climb up to that first (the
          // playlist layout ships nested and used to throw here).
          const ccBtn = controls.querySelector('.ytp-subtitles-button');
          let anchor: Element | null = ccBtn;
          while (anchor && anchor.parentElement !== controls) anchor = anchor.parentElement;
          controls.insertBefore(btn, anchor ?? controls.firstChild);
        }
        syncStyle(btn);
      } catch {
        /* retried by the next tick */
      }
    };
    ensure();
    const timer = window.setInterval(ensure, 1500);
    window.addEventListener('yt-navigate-finish', ensure);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('yt-navigate-finish', ensure);
      document.getElementById('tokori-ocr-ytp-btn')?.remove();
    };
  }, [isYouTube]);

  // Reflect a Subtitle-menu change on the player-bar button immediately
  // (the attach loop above would catch it 1.5s later).
  useEffect(() => {
    const btn = document.getElementById('tokori-ocr-ytp-btn') as HTMLButtonElement | null;
    if (!btn) return;
    const on = trackChoice === 'ocr';
    btn.setAttribute('aria-pressed', String(on));
    btn.style.boxShadow = on ? 'inset 0 -3px 0 #f00' : 'none';
    btn.style.opacity = on ? '1' : '0.85';
  }, [trackChoice]);

  // ── Drag-anywhere ──────────────────────────────────────────────
  // OCR mode drags (and persists) its own offset — the OCR bar lives
  // at the opposite side of the player from the capture region, and
  // repositioning it must not move the normal caption overlay.
  const activeOffset = ocrMode ? ocrOffset : offset;
  const onContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Allow native interaction on form controls.
      const target = e.target as HTMLElement;
      if (target.closest('select, option, input, textarea')) return;
      e.preventDefault();
      dragRef.current.moved = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const origDx = activeOffset?.dx ?? 0;
      const origDy = activeOffset?.dy ?? 0;
      const setActive = ocrMode ? setOcrOffset : setOffset;
      const posKey = ocrMode ? OCR_POS_STORAGE_KEY : POS_STORAGE_KEY;

      const onMove = (ev: MouseEvent) => {
        const ddx = ev.clientX - startX;
        const ddy = ev.clientY - startY;
        if (!dragRef.current.moved && Math.hypot(ddx, ddy) > DRAG_THRESHOLD_PX) {
          dragRef.current.moved = true;
        }
        if (dragRef.current.moved) {
          setActive({ dx: origDx + ddx, dy: origDy + ddy });
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
              chrome.storage.local.set({ [posKey]: final });
            } catch {}
          }
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [activeOffset, ocrMode],
  );

  // Track latest offset for the mouseup save (avoids stale closure).
  const latestOffsetRef = useRef<DragOffset | null>(activeOffset);
  useEffect(() => {
    latestOffsetRef.current = activeOffset;
  }, [activeOffset]);

  function resetPosition() {
    (ocrMode ? setOcrOffset : setOffset)(null);
    try {
      chrome.storage.local.remove(ocrMode ? OCR_POS_STORAGE_KEY : POS_STORAGE_KEY);
    } catch {}
  }

  /** Adopt a (possibly changed) target language from settings. A
   *  change resets the MAIN world's pinned track — the automatic pick
   *  re-runs for the new target — so the cue state resets with it.
   *  Only ever called from async callbacks, so reading the ref mirror
   *  (kept fresh each render, declared below) is safe. */
  function applyTargetLang(lang: LanguageCode) {
    if (targetLangRef.current === lang) return;
    setTargetLang(lang);
    setTrackChoice('auto');
    trackAdoptableRef.current = true;
    setAutoEngaged(true);
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

  /** Subtitle menu (YouTube-CC-menu equivalent): pin the native line to
   *  a real track ("original"), an auto-translate language, burned-in
   *  OCR, turn the overlay off entirely, or hand the choice back to
   *  the automatic pick. */
  function changeTrackChoice(value: string) {
    setTrackChoice(value);
    // A user pin freezes the select; picking Auto re-opens it to
    // auto-pick reflection.
    trackAdoptableRef.current = value === 'auto';
    // Optimistic: a pin engages the MAIN world regardless of the
    // tracklist; re-picking Auto makes it re-evaluate (and it
    // re-announces hands-off if the verdict still holds).
    setAutoEngaged(true);
    let detail: Record<string, string> = { mode: 'auto' };
    if (value === 'ocr' || value === 'off') {
      // OCR owns the overlay — park the MAIN world's track steering so
      // it neither flips the player's CC nor streams timedtext cues.
      // Off parks it for the same reason: the user asked the extension
      // to stand down on this video, so no steering and no streaming.
      detail = { mode: 'suspend' };
    } else if (value.startsWith('track:')) {
      const vssId = value.slice('track:'.length);
      const t = ccTracks.tracks.find((x) => x.vssId === vssId);
      detail = { mode: 'track', vssId, lang: t?.languageCode || '' };
    } else if (value.startsWith('tlang:')) {
      detail = { mode: 'tlang', tlang: value.slice('tlang:'.length) };
    }
    window.dispatchEvent(new CustomEvent('tokori-yt-set-track', { detail }));
    // Same cue reset as a language change — the streams repopulate
    // from the fresh selection round.
    setNative([]);
    setTranslated([]);
    setActiveNative(null);
    setActiveTranslated(null);
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
  // off hides the ENTIRE on-video overlay — caption lines AND the
  // toolbar — so nothing of ours floats over a video the user chose to
  // watch without captions (no hover-revealed bar). Turning CC back on
  // restores it; OCR mode owns the overlay independently (exempt below)
  // and stays reachable meanwhile via its dedicated player-bar button.
  // The transcript sidebar is independently controlled and survives the
  // toggle too.
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
  // Subtitle menu → Off: the user asked the extension's captions off
  // for this video (resets to Auto on navigation). This is the ONLY
  // off-switch on videos where YouTube renders no CC button (hidden
  // auto-generated tracks are common) — ccPaused can never fire there.
  const overlayOff = trackChoice === 'off';
  // Auto found no caption track in the target language, so the MAIN
  // world is hands-off and YouTube's own captions run untouched. The
  // overlay stays out of the way too: no cue lines are coming, the
  // toolbar reveals on hover only, and the Subtitle menu explains why.
  const autoIdle = trackChoice === 'auto' && !autoEngaged;
  const targetLangName = targetLang
    ? getLanguage(targetLang)?.name || targetLang
    : 'target-language';
  // OCR lines are our own explicit mode — they ignore the CC toggle.
  const showCueLines = (!ccPaused || ocrMode) && !overlayOff;
  // The whole on-video bar shares that gate: when the user turns CC off
  // (on a captioned video) the toolbar comes down with the cue lines —
  // no bar left hovering over the video. OCR mode keeps it up. Off
  // keeps the BAR mounted (hover-revealed) so the choice stays
  // reversible even without a YT CC button to re-summon it with.
  const showOverlay = showCueLines || overlayOff;

  // ── Positioning ────────────────────────────────────────────────
  // Default anchor = bottom-centre of the player, offset 12% up. In
  // OCR mode the bar instead sits on the OPPOSITE side of the capture
  // region — reading bottom-strip subs puts the interactive bar at the
  // top of the player, so it never covers the burned-in text it is
  // transcribing. The user's drag offset layers on top either way.
  const anchorStyle: React.CSSProperties = (() => {
    const region = ocrRegion ?? DEFAULT_OCR_REGION;
    const barAtTop = ocrMode && region.y + region.h / 2 >= 0.5;
    if (!playerRect) {
      return barAtTop
        ? { left: '50%', top: '10%', transform: 'translateX(-50%)' }
        : { left: '50%', bottom: '12%', transform: 'translateX(-50%)' };
    }
    const baseX = playerRect.left + playerRect.width / 2;
    const baseY = barAtTop
      ? playerRect.top + playerRect.height * 0.08 // just under the top edge
      : playerRect.top + playerRect.height * 0.88; // 12% up from bottom
    const x = baseX + (activeOffset?.dx ?? 0);
    const y = baseY + (activeOffset?.dy ?? 0);
    // Clamp so the overlay never escapes the player bounds.
    const minX = playerRect.left + 80;
    const maxX = playerRect.right - 80;
    const minY = playerRect.top + 30;
    const maxY = playerRect.bottom - 30;
    return {
      left: clamp(x, minX, maxX),
      top: clamp(y, minY, maxY),
      // Top-anchored bars grow downward; bottom-anchored grow upward.
      transform: barAtTop ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    };
  })();

  return (
    <>
      {selectingRegion && (
        <OcrRegionSelector
          current={ocrRegion}
          onSelect={saveOcrRegion}
          onCancel={() => setSelectingRegion(false)}
          videoSelector={videoSel}
        />
      )}
      <CaptionSidebar
        open={sidebarOpen && !isShorts}
        onClose={() => toggleSidebar(false)}
        native={nativeCues}
        translated={translatedCues}
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
      {showOverlay && (
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
          {/* Toolbar. Drag handle removed — drag works anywhere now. */}
          <div
            style={s({
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              // The portrait Shorts player is ~360-480px wide — the pill
              // row must be allowed to wrap instead of spilling past the
              // video edges.
              flexWrap: 'wrap',
              gap: '6px',
              marginBottom: '4px',
              // Pinned visible while loading cues on a captioned video
              // ("something is coming") and while OCR hunts its first
              // line (the "OCR watching…" status is the feedback).
              // Otherwise — cues flowing, CC toggled off, subtitles set
              // to Off, a caption-less video, or a hands-off video (no
              // target-language track) — reveal on hover only.
              opacity:
                hovered ||
                autoIdleFlash ||
                (!overlayOff &&
                  ((!hasAnyCue && !ccAbsent && !ccPaused && !autoIdle) || (ocrMode && !hasAnyCue)))
                  ? 1
                  : 0,
              transition: 'opacity 120ms ease',
              pointerEvents: 'auto',
            })}
          >
            {/* Always rendered: OCR must stay reachable on videos with
                no caption tracks at all — that's exactly when burned-in
                subtitles are the only source. */}
            {
              <label
                title="Subtitle source — the video's original caption tracks or an auto-translation, like YouTube's own CC menu. Auto picks for your target language (set in Options) and the menu lands on that pick. OCR reads burned-in (hardcoded) subtitles off the frame (local model or AI key — Options → AI)."
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
                  Subtitle
                </span>
                <select
                  value={trackChoice}
                  onChange={(e) => changeTrackChoice(e.target.value)}
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
                    // The auto-translate list is ~130 entries with long
                    // names — cap the closed control so the pill stays
                    // compact (the open dropdown shows full labels).
                    // 130px matches the streaming toolbar's selects;
                    // the closed control now usually shows a language
                    // name (the reflected auto pick), not "Auto".
                    maxWidth: '130px',
                  })}
                >
                  {/* The extension's own off-switch. Essential on videos
                      where YouTube renders no CC button (hidden auto-gen
                      tracks): ccPaused can never fire there, so without
                      this the overlay would be impossible to dismiss. */}
                  <option value="off" style={{ background: '#111' }}>
                    Off
                  </option>
                  <option value="auto" style={{ background: '#111' }}>
                    {autoIdle ? `Auto (no ${targetLangName} CC)` : 'Auto'}
                  </option>
                  <option value="ocr" style={{ background: '#111' }}>
                    OCR: burned-in subs (AI)
                  </option>
                  {ccTracks.tracks.length > 0 && (
                    <optgroup label="Captions" style={{ background: '#111' }}>
                      {ccTracks.tracks.map((t) => (
                        <option
                          key={t.vssId || t.languageCode}
                          value={`track:${t.vssId}`}
                          style={{ background: '#111' }}
                        >
                          {t.label}
                          {/* Tracklists read from getPlayerResponse already
                              carry a localized "(auto-generated)" in the
                              label — don't stack a second one. */}
                          {t.kind === 'asr' && !/auto/i.test(t.label) ? ' (auto-generated)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {ccTracks.translations.length > 0 && (
                    <optgroup label="Auto-translate" style={{ background: '#111' }}>
                      {ccTracks.translations.map((l) => (
                        <option
                          key={l.code}
                          value={`tlang:${l.code}`}
                          style={{ background: '#111' }}
                        >
                          {l.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            }

            {autoIdle && (
              <span
                title={`This video has no ${targetLangName} caption track, so Tokori is leaving YouTube's own subtitles alone. To study it anyway, pick a source from the Subtitle menu: an Auto-translate language, a caption track as-is, or OCR for burned-in subs.`}
                style={s({
                  background: 'rgba(0,0,0,0.5)',
                  color: TOKENS.textMuted,
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '999px',
                  padding: '2px 8px',
                  fontSize: '10px',
                  cursor: 'help',
                })}
              >
                No {targetLangName} CC
              </span>
            )}

            {ocrMode && (
              <span
                title={
                  ocr.error
                    ? `OCR problem — ${ocr.error}`
                    : 'Reading burned-in subtitles from the video frame with your OCR engine (local model or AI key — Options → AI); the translation line uses your translate engine.'
                }
                style={s({
                  background: 'rgba(0,0,0,0.5)',
                  color: ocr.error ? '#fbbf24' : TOKENS.textMuted,
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '999px',
                  padding: '2px 8px',
                  fontSize: '10px',
                  cursor: 'help',
                })}
              >
                {ocr.error ? '⚠ OCR' : nativeCues.length > 0 ? 'OCR live' : 'OCR watching…'}
              </span>
            )}

            {ocrMode && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectingRegion(true);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                title="Choose where on the video the burned-in subtitles are — the OCR only reads that area"
                style={s({
                  background: 'rgba(0,0,0,0.7)',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '999px',
                  padding: '3px 10px',
                  fontSize: '11px',
                  cursor: 'pointer',
                })}
              >
                ⛶ Region
              </button>
            )}

            {activeOffset && (
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
                cycleEnMode();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title={
                enMode === 'blur'
                  ? 'EN line is blurred — click a line to reveal it. Click here for: off'
                  : enMode === 'show'
                    ? 'EN line is always visible. Click here for: blurred'
                    : 'EN line is OFF — nothing is translated or shown. Click here for: visible'
              }
              style={s({
                background: enMode !== 'off' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.5)',
                color: enMode !== 'off' ? '#fff' : TOKENS.textMuted,
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: 'pointer',
              })}
            >
              EN: {enMode}
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

            {/* Add-to-library moved into YouTube's own action bar (the
                portal below) — always visible there, not just while
                the caption overlay is up. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleTimer();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title={
                timerIdle
                  ? "Immersion timer running, but not counting — this video isn't in your Tokori library. Add it (＋ Tokori) to count it, or click to stop the session."
                  : timerPaused
                    ? 'Immersion timer paused (video paused, or paused from the Tokori desktop sidebar). Play the video to resume, or click to stop and log the session.'
                    : immersion.active
                      ? 'Immersion timer running — click to stop and log the session'
                      : 'Start the immersion timer (study mode). Time only counts while a library video plays; see Stats in the extension popup.'
              }
              aria-label={immersion.active ? 'Stop immersion timer' : 'Start immersion timer'}
              style={s({
                background:
                  timerIdle || timerPaused
                    ? 'rgba(251,191,36,0.2)'
                    : immersion.active
                      ? 'rgba(16,185,129,0.25)'
                      : 'rgba(0,0,0,0.7)',
                color: '#fff',
                border:
                  timerIdle || timerPaused
                    ? '1px solid rgba(251,191,36,0.55)'
                    : immersion.active
                      ? '1px solid rgba(16,185,129,0.6)'
                      : '1px solid rgba(255,255,255,0.15)',
                borderRadius: '999px',
                padding: '3px 10px',
                fontSize: '11px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontVariantNumeric: 'tabular-nums',
              })}
            >
              <span aria-hidden>{timerIdle || timerPaused ? '⏸' : '⏱'}</span>
              <span>{immersion.active ? formatTimer(immersion.ms) : 'Immerse'}</span>
            </button>

            {/* No sidebar on Shorts — there's no #secondary column to
                dock into, and a ≤60s loop has no use for a transcript. */}
            {!isShorts && (
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
            )}

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
          {showCueLines && displayedNative && lang && (
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
                          cues: nativeCues.map((c) => ({ text: c.text, start: c.start })),
                          index: nativeCues.findIndex((c) => c.start === displayedNative.start),
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
          {showCueLines &&
            enMode !== 'off' &&
            displayedTranslated &&
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

      {/* Native action-bar buttons — rendered into YouTube's own
          like/Share row via the portal container the attach loop
          maintains. Styled as YT chips so they read as part of the
          page, not an overlay. */}
      {actionBarEl &&
        createPortal(
          <NativeBarButtons
            listState={listState}
            listError={listError}
            onAdd={addToWatchList}
            timerActive={immersion.active}
            timerIdle={timerIdle}
            timerPaused={timerPaused}
            timerMs={immersion.ms}
            onToggleTimer={toggleTimer}
          />,
          actionBarEl,
        )}
    </>
  );
}

/** The two chips injected into YouTube's action row. Colors follow
 *  YT's own light/dark chips (html[dark]) rather than our overlay
 *  tokens, so they sit next to like/Share without looking pasted on. */
function NativeBarButtons({
  listState,
  listError,
  onAdd,
  timerActive,
  timerIdle,
  timerPaused,
  timerMs,
  onToggleTimer,
}: {
  listState: 'hidden' | 'out' | 'busy' | 'in';
  listError: string | null;
  onAdd: () => void;
  timerActive: boolean;
  /** Running but not counting — the current video isn't a library item. */
  timerIdle: boolean;
  /** Running but frozen — video paused or paused from the desktop. */
  timerPaused: boolean;
  timerMs: number;
  onToggleTimer: () => void;
}) {
  const dark = document.documentElement.hasAttribute('dark');
  const chip = (active: boolean): CSSProperties => ({
    height: '36px',
    borderRadius: '18px',
    padding: '0 14px',
    border: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: '"Roboto","Arial",sans-serif',
    fontSize: '14px',
    fontWeight: 500,
    lineHeight: '36px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    background: active
      ? 'rgba(16,185,129,0.18)'
      : dark
        ? 'rgba(255,255,255,0.1)'
        : 'rgba(0,0,0,0.05)',
    color: active ? (dark ? '#34d399' : '#047857') : dark ? '#f1f1f1' : '#0f0f0f',
    fontVariantNumeric: 'tabular-nums',
  });
  return (
    <>
      <button
        type="button"
        onClick={onAdd}
        disabled={listState === 'busy' || listState === 'in'}
        title={
          listError
            ? `Couldn't add to your library — ${listError}`
            : listState === 'in'
              ? 'In your Tokori library — the immersion timer auto-starts and tracks your progress'
              : 'Add this video to your Tokori library (progress tracks while the timer runs)'
        }
        aria-label={listState === 'in' ? 'In your Tokori library' : 'Add to Tokori library'}
        style={{
          ...chip(listState === 'in'),
          cursor: listState === 'out' ? 'pointer' : 'default',
        }}
      >
        <span aria-hidden>{listState === 'in' ? '✓' : '＋'}</span>
        <span>{listState === 'in' ? 'Tokori' : listState === 'busy' ? 'Adding…' : 'Tokori'}</span>
      </button>
      <button
        type="button"
        onClick={onToggleTimer}
        title={
          timerIdle
            ? "Immersion timer running, but not counting — this video isn't in your Tokori library. Add it to count it, or click to stop the session."
            : timerPaused
              ? 'Immersion timer paused (video paused, or paused from the Tokori desktop sidebar). Play the video to resume, or click to stop and log the session.'
              : timerActive
                ? 'Immersion timer running — click to stop and log the session'
                : 'Start the immersion timer (study mode). Time only counts while a library video plays.'
        }
        aria-label={timerActive ? 'Stop immersion timer' : 'Start immersion timer'}
        style={{
          ...chip(timerActive && !timerIdle && !timerPaused),
          ...(timerIdle || timerPaused
            ? { background: 'rgba(251,191,36,0.18)', color: dark ? '#fbbf24' : '#92400e' }
            : {}),
        }}
      >
        <span aria-hidden>{timerIdle || timerPaused ? '⏸' : '⏱'}</span>
        <span>{timerActive ? formatTimer(timerMs) : 'Immerse'}</span>
      </button>
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

/** Best-effort channel-name scrape for the watch-list "author" field.
 *  YT rearranges these nodes across experiments — every selector is a
 *  fallback, and `undefined` (no author) is a fine outcome. */
function scrapeChannelName(): string | undefined {
  const el =
    document.querySelector('#above-the-fold ytd-channel-name a') ||
    document.querySelector('ytd-video-owner-renderer ytd-channel-name a') ||
    document.querySelector('#owner #channel-name a');
  const name = el?.textContent?.trim();
  return name || undefined;
}

// Caption tokeniser (Token, tokenize, segmentText) now lives in
// ./youtube/caption-tokenize.
