/// <reference lib="dom" />

import {
  matchesLang,
  planRestingPick,
  SIMPLIFIED_CODES,
  type PickableTrack,
} from '../lib/yt-track-pick';

/**
 * MAIN-world script: capture YouTube's own timedtext fetches so we can
 * mirror the player's native + machine-translated cue tracks into the
 * page for the overlay enhancer to consume.
 *
 * Same pattern Hanpanda used — we don't make our own API calls
 * (YouTube rate-limits /api/timedtext aggressively when the same
 * client hits it twice in a row). Instead we monkey-patch
 * XMLHttpRequest + fetch, watch for `/api/timedtext` responses, and
 * dispatch the parsed cues back to the content-script world via
 * `window.dispatchEvent`.
 *
 * Lives in the MAIN world (declared in manifest) so it shares scope
 * with `movie_player`.
 *
 * Track selection (target-language aware):
 *   1. The content script tells us the user's target language via a
 *      `tokori-yt-set-target-lang` event. Default is English so the
 *      script still does something useful before the overlay mounts.
 *   2. We look for a *real* native track in the target language and
 *      activate it ("Chinese first" if target=zh).
 *   3. If no matching native track exists, we go HANDS-OFF for the
 *      video: no steering, no cue dispatch, no hiding — YouTube's own
 *      captions behave exactly as stock. (Auto-translating a base
 *      track into the target used to be the fallback here; it broke
 *      more than it fixed — "auto → undefined" in YT's CC menu,
 *      cue-less overlays, whole-transcript pile-ups. See
 *      lib/yt-track-pick. The user can still pin an auto-translate
 *      language from the overlay's Subtitle menu.)
 *   4. On videos we do own, we also trigger a translation to the
 *      display language (English for now) for the second/translated
 *      line.
 *   5. A pick made in YouTube's OWN subtitles menu is detected (guarded
 *      poll of the captions track option) and adopted as a pin, so the
 *      native menu and the overlay's Subtitle menu always agree.
 *
 * Cue classification: native vs translated is decided by inspecting
 * the URL's `tlang` and `lang` query params and matching them against
 * the current target / display language.
 */

interface TimedCue {
  start: number;
  dur: number;
  text: string;
}

const DISPLAY_LANG = 'en';

let currentTargetLang = 'en';
/** Whether the content script has told us the user's real target
 *  language yet. Until then (grace-capped) we neither select tracks nor
 *  classify cues — the 'en' default otherwise races the event and a
 *  first round selected FOR ENGLISH: on a zh-Hant-only video that
 *  rested on the →en translation and dispatched English cues as the
 *  "native" line (the English-flickering-in-the-top-line bug). */
let targetLangReady = false;
const SCRIPT_START = Date.now();
function targetSettled(): boolean {
  // 12s grace: if no event ever arrives (extension surface not mounted),
  // fall back to the default so plain-English users still get captions.
  // Sized generously — this script runs at document_start (the network
  // hooks must beat the player's fetch capture) while the content
  // script that reports the language only runs at document_idle.
  return targetLangReady || Date.now() - SCRIPT_START > 12_000;
}

/** YouTube's translate menu has no bare "zh" — Chinese auto-translation
 *  is offered as Simplified / Traditional variants only. Learners on
 *  this extension study Simplified by default (CC-CEDICT keys,
 *  workspaces), so "zh" maps to zh-Hans. `matchesLang` already treats
 *  any zh-* as matching target "zh", so classification is unaffected. */
function toYtTranslateCode(code: string): string {
  return code === 'zh' ? 'zh-Hans' : code;
}

/** Resolve the translate code the PLAYER actually offers for `target`.
 *  Our language codes ('zh', 'pt', …) don't always exist verbatim in
 *  YouTube's translationLanguages list (zh-Hans/zh-Hant, pt-BR/pt-PT,
 *  legacy aliases) — asking for an unlisted code silently yields no
 *  cues. Exact match wins, then the Simplified variant for zh, then any
 *  prefix match; falls back to the static mapping when the option
 *  isn't readable. */
function resolveTranslateCode(player: YTPlayer, target: string): string {
  const fallback = toYtTranslateCode(target);
  try {
    const list = readTranslationLanguages(player);
    const codes = list.map((l) => l.languageCode || '').filter(Boolean);
    if (!codes.length) return fallback;
    const exact = codes.find((c) => c.toLowerCase() === fallback.toLowerCase());
    if (exact) return exact;
    if (target === 'zh') {
      const hans = codes.find((c) => SIMPLIFIED_CODES.includes(c.toLowerCase()));
      if (hans) return hans;
    }
    const prefix = codes.find((c) => matchesLang(c, target));
    return prefix || fallback;
  } catch {
    return fallback;
  }
}

/** Is `target` actually offered by this video's auto-translate menu?
 *  Selecting a translation the player doesn't list silently yields no
 *  cues (and a "… → undefined" entry in YouTube's own CC menu), so
 *  every translation we activate passes this gate first. */
function translationOffered(player: YTPlayer, target: string): boolean {
  const codes = readTranslationLanguages(player).map((l) => (l.languageCode || '').toLowerCase());
  return codes.includes(resolveTranslateCode(player, target).toLowerCase());
}

/** Build the auto-translate track object for `setOption('captions',
 *  'track', …)`. The translationLanguage entry is copied VERBATIM from
 *  the player's own translationLanguages list — languageName included —
 *  because YouTube renders its CC-menu label straight off this object:
 *  passing only a languageCode is what made the menu literally read
 *  "… → undefined". */
function makeTranslationTrack(player: YTPlayer, source: TrackInfo, code: string): unknown {
  const entry = readTranslationLanguages(player).find(
    (l) => (l.languageCode || '').toLowerCase() === code.toLowerCase(),
  );
  return { ...source, translationLanguage: entry ? { ...entry } : { languageCode: code } };
}

/** User-pinned source for the NATIVE caption line — the same choices
 *  YouTube's own CC menu offers. Set from the overlay's subtitle
 *  dropdown via `tokori-yt-set-track`:
 *    • auto  — this script's automatic pick (target-language track,
 *              script-aware zh handling, auto-translate fallback).
 *    • track — a specific REAL track, verbatim (the "original").
 *    • tlang — auto-translate the base track to a chosen language.
 *  Resets to auto on navigation (vssIds are per-video) and on target-
 *  language change (the auto pick should re-run for the new target). */
type NativeOverride =
  | { mode: 'auto' }
  | { mode: 'track'; vssId: string; lang: string }
  | { mode: 'tlang'; tlang: string };
let nativeOverride: NativeOverride = { mode: 'auto' };

let nativeCuesSent = false;
let translatedCuesSent = false;
/** User preference (overlay's EN pill → "off"): skip everything about
 *  the display-language line — no translated-track excursions, no
 *  translated-cue dispatches. A user preference, NOT per-video state:
 *  navigation must not reset it. */
let translationDisabled = false;
let triggeredForVideo = '';
let selectionRetryTimer: number | null = null;
/** Set when the user turns the player's CC button off. While true, all
 *  track selection is suspended — the selection retry loop and the
 *  staggered "grab the translated track" flips would otherwise call
 *  `setOption('captions', …)`, which re-enables captions and makes the
 *  overlay pop right back after the user dismissed it. Cleared when the
 *  user turns CC back on or a new video starts. */
let ccUserOff = false;
/** Set while the overlay's OCR mode owns the captions (`tokori-yt-set-track`
 *  with mode 'suspend'): all track steering pauses and timedtext cues stop
 *  dispatching, so the OCR stream is the only cue source. Cleared by any
 *  other track choice, a target-language change, or navigation. */
let selectionSuspended = false;
/** Extra full retry rounds already spent on the current video (see the
 *  25s release timeout in `poll`). Reset on navigation / lang change. */
let retryRounds = 0;
/** Set once the player response is loaded and shows the current video has
 *  NO caption tracks at all — a genuinely subtitle-less video. Stops the
 *  ~21s retry spin (and its 25s extra rounds) early: there is nothing to
 *  find, so "loading" forever is just wasted work (OCR mode, which reads
 *  burned-in subs off the frame, is the path for these and runs on its
 *  own). Reset on navigation / language change. */
let captionsUnavailable = false;
/** Auto mode found NO target-language caption track on this video — the
 *  script is HANDS-OFF: no steering, no cue dispatch, no native-CC
 *  hiding. YouTube behaves exactly as stock until the user pins a
 *  source in the Subtitle menu or the target language changes. */
let autoHandsOff = false;
/** Video the hands-off entry work (leftover-translation cleanup + the
 *  overlay notification) already ran for — once per video. */
let handsOffFor = '';
/** Bumped every time the user changes target language (or a new video
 *  starts) so the staggered track-flip timeouts can bail when they
 *  belong to a previous run — otherwise a queued "flip to translated"
 *  callback from the old language would briefly select the wrong track
 *  and pollute the translated-cue stream. */
let selectionGen = 0;

function getVideoId(): string {
  return (window.location.search.match(/[?&]v=([^&]+)/) || [])[1] || '';
}

function parseEventsJson(data: {
  events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }>;
}): TimedCue[] {
  const cues: TimedCue[] = [];
  for (const ev of data?.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || '')
      .join('')
      .trim();
    if (text && ev.tStartMs !== undefined) {
      cues.push({ start: ev.tStartMs / 1000, dur: (ev.dDurationMs || 0) / 1000, text });
    }
  }
  return cues;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&amp;/g, '&'); // last, or escaped entities double-decode
}

/** YouTube XML timedtext → cues, parsed with REGEXES on purpose.
 *  youtube.com enforces Trusted Types (`require-trusted-types-for
 *  'script'`), where `DOMParser.parseFromString` is a guarded sink: it
 *  throws — and logs a scary CSP violation — even when the caller
 *  catches, and the cues are silently lost. Handles both the legacy
 *  `<text start=".." dur="..">` shape (seconds) and the srv3
 *  `<p t=".." d="..">` shape (milliseconds, nested `<s>` word
 *  segments). */
function parseTimedXml(xml: string): TimedCue[] {
  const cues: TimedCue[] = [];
  const num = (attrs: string, name: string): number => {
    const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
    return m ? parseFloat(m[1]!) : NaN;
  };
  const push = (start: number, dur: number, raw: string) => {
    const text = decodeXmlEntities(raw.replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (text && Number.isFinite(start)) {
      cues.push({ start, dur: Number.isFinite(dur) ? dur : 0, text });
    }
  };
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    push(num(m[1]!, 'start'), num(m[1]!, 'dur'), m[2]!);
  }
  if (cues.length === 0) {
    for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      push(num(m[1]!, 't') / 1000, num(m[1]!, 'd') / 1000, m[2]!);
    }
  }
  return cues;
}

function textToCues(text: string): TimedCue[] {
  if (!text || text.length < 10) return [];
  try {
    const c = parseEventsJson(JSON.parse(text));
    if (c.length) return c;
  } catch {}
  // Only attempt XML on XML-looking bodies — a json3 response with no
  // usable events used to fall through into the XML parser for nothing.
  if (text.trimStart().startsWith('<')) {
    try {
      const c = parseTimedXml(text);
      if (c.length) return c;
    } catch {}
  }
  return [];
}

/** Decide whether a `/api/timedtext` URL is the user's "native"
 *  (target-language) track, the "translated" (display-language)
 *  track, or neither. Looks at `tlang` (auto-translate target) and
 *  `lang` (true native track language). */
function classify(url: string): 'native' | 'translated' | null {
  if (!url.includes('/api/timedtext')) return null;
  let u: URL;
  try {
    u = new URL(url, location.href);
  } catch {
    return null;
  }
  const tlang = (u.searchParams.get('tlang') || '').toLowerCase();
  const lang = (u.searchParams.get('lang') || '').toLowerCase();
  // A pinned track / translate choice redefines what "native" means;
  // the translated (display-language) line keeps its usual rules.
  if (nativeOverride.mode === 'track') {
    if (!tlang && matchesLang(lang, nativeOverride.lang)) return 'native';
    if (tlang ? matchesLang(tlang, DISPLAY_LANG) : matchesLang(lang, DISPLAY_LANG))
      return 'translated';
    return null;
  }
  if (nativeOverride.mode === 'tlang') {
    if (tlang && matchesLang(tlang, nativeOverride.tlang)) return 'native';
    if (tlang ? matchesLang(tlang, DISPLAY_LANG) : matchesLang(lang, DISPLAY_LANG))
      return 'translated';
    return null;
  }
  if (tlang) {
    if (matchesLang(tlang, currentTargetLang)) return 'native';
    if (matchesLang(tlang, DISPLAY_LANG)) return 'translated';
    return null;
  }
  // Untranslated native track. Only treat as the user's "native" line
  // if it actually matches the target language — otherwise we'd put
  // English/etc cues in the top line of someone learning Chinese.
  if (matchesLang(lang, currentTargetLang)) return 'native';
  // A REAL display-language track is just as good as an auto-translated
  // one — videos with human English subs feed the bottom line directly.
  if (matchesLang(lang, DISPLAY_LANG)) return 'translated';
  return null;
}

function dispatchCues(url: string, text: string) {
  // Don't classify against the placeholder target — YT often fetches an
  // English track on its own at load (user's CC preference), and with
  // the default target 'en' that would dispatch English as "native".
  if (!targetSettled()) return;
  // OCR mode owns the overlay — timedtext must not race its cues.
  if (selectionSuspended) return;
  // Hands-off video (no target-language track): the overlay must stay
  // empty. Dispatching here would hand it e.g. the video's own English
  // track as a "translated" line — which makes the overlay hide
  // YouTube's native captions while rendering nothing itself.
  if (autoHandsOff) return;
  // Timedtext responses name the video they belong to (`v=`). A late
  // response from the PREVIOUS video — an in-flight fetch at nav time,
  // or one of our own track-flip refetches outliving the video — must
  // be dropped: dispatching it would show the old video's captions on
  // the new one AND consume the once-flags below, blocking the new
  // video's real cues for the whole selection round. Responses with no
  // current watch id (home-feed hover previews) are useless to the
  // overlay and would burn the flags the same way.
  const curVid = getVideoId();
  if (!curVid) return;
  let respVid = '';
  try {
    respVid = new URL(url, location.href).searchParams.get('v') || '';
  } catch {
    /* unparsable URL — fall through, id check is best-effort */
  }
  if (respVid && respVid !== curVid) return;
  const kind = classify(url);
  if (!kind) return;
  const cues = textToCues(text);
  if (cues.length === 0) return;
  if (kind === 'native' && !nativeCuesSent) {
    window.dispatchEvent(
      new CustomEvent('tokori-yt-native-cues', { detail: { cues, url, videoId: curVid } }),
    );
    nativeCuesSent = true;
  }
  if (kind === 'translated' && !translatedCuesSent && !translationDisabled) {
    window.dispatchEvent(
      new CustomEvent('tokori-yt-translated-cues', { detail: { cues, url, videoId: curVid } }),
    );
    translatedCuesSent = true;
  }
}

// ── Captured-response retention (the "sometimes no captions" fix) ──
//
// Every timedtext body the hooks see is stored verbatim, keyed by URL,
// for the CURRENT video. The single dispatch in `dispatchCues` used to
// be the ONLY chance to deliver a response: if it arrived before the
// target language settled, before the overlay's listeners mounted, or
// before the user pinned the track it belongs to, it was dropped and
// only ever recovered by forcing the player to REFETCH (an excursion
// flip, or setOption('reload')) — the flaky, rate-limit-prone path that
// made captions load "sometimes". Retaining the body lets us re-serve it
// the instant the target settles / a pin lands / the overlay asks for a
// replay, with no player refetch at all. This is the asbplayer/Yomitan
// "hold the data, let consumers re-request it" model that the Netflix
// and Disney paths already get for free (their cues are fetched on
// demand from a retained track list).
interface CapturedTimedText {
  /** `v=` from the response URL — so a body outlives a navigation
   *  without ever being served to the wrong video. */
  v: string;
  text: string;
}
const capturedByUrl = new Map<string, CapturedTimedText>();
/** A watched video rarely fetches more than a handful of tracks; cap
 *  well above that so a pathological session can't grow unbounded, and
 *  clear on navigation anyway. */
const CAPTURE_LIMIT = 80;

/** Store a timedtext body, then attempt the live dispatch. Called by
 *  both network hooks in place of `dispatchCues` so retention happens
 *  even when the live dispatch is dropped (target not settled, wrong
 *  video, once-flag already spent). */
function captureTimedText(url: string, text: string) {
  if (!text || text.length < 10) return;
  let v = '';
  try {
    v = new URL(url, location.href).searchParams.get('v') || '';
  } catch {
    /* unparsable URL — retain it anyway, keyed by the raw string */
  }
  if (capturedByUrl.size >= CAPTURE_LIMIT && !capturedByUrl.has(url)) {
    const oldest = capturedByUrl.keys().next().value;
    if (oldest) capturedByUrl.delete(oldest);
  }
  capturedByUrl.set(url, { v, text });
  dispatchCues(url, text);
}

/** Re-run classification + dispatch over every retained body for the
 *  current video. Idempotent: `dispatchCues`'s once-flags + video-id +
 *  classify guards make a re-emit a no-op once a line is already sent,
 *  so this is safe to call liberally (each selection-retry tick, on a
 *  target/override change, on an overlay replay request). Cheap early
 *  bail once both lines are delivered. */
function redispatchCaptured() {
  if (nativeCuesSent && (translatedCuesSent || translationDisabled)) return;
  const curVid = getVideoId();
  if (!curVid) return;
  for (const [url, cap] of capturedByUrl) {
    if (cap.v && cap.v !== curVid) continue;
    dispatchCues(url, cap.text);
  }
}

// ── XHR hook ──────────────────────────────────────────────────────
const _origOpen = XMLHttpRequest.prototype.open;
const _origSend = XMLHttpRequest.prototype.send;

/* eslint-disable @typescript-eslint/no-explicit-any */
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: any[]
) {
  (this as XMLHttpRequest & { _tkUrl?: string })._tkUrl = url?.toString() || '';
  return (_origOpen as any).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: any[]) {
  const xhr = this as XMLHttpRequest & { _tkUrl?: string };
  const url = xhr._tkUrl || '';
  if (url.includes('/api/timedtext')) {
    xhr.addEventListener('load', function () {
      // 429 (or any 4xx/5xx) = rate-limited / no usable body. Record it
      // and back off so the excursion loop stops re-issuing the same
      // pot-signed URL — every retry just earns another 429.
      if (xhr.status >= 400) {
        lastRateLimitAt = Date.now();
        return;
      }
      // Read the body through whatever responseType the player asked
      // for — responseText THROWS on non-text types, and one uncaught
      // throw here would kill the capture for the whole video.
      let text = '';
      try {
        if (!xhr.responseType || xhr.responseType === 'text') {
          text = xhr.responseText || '';
        } else if (xhr.responseType === 'json') {
          text = xhr.response ? JSON.stringify(xhr.response) : '';
        } else if (xhr.responseType === 'arraybuffer' && xhr.response) {
          text = new TextDecoder().decode(xhr.response as ArrayBuffer);
        }
      } catch {
        /* leave empty — nothing to dispatch */
      }
      if (text) captureTimedText(url, text);
    });
  }
  return (_origSend as any).call(this, ...args);
} as typeof XMLHttpRequest.prototype.send;

// ── fetch hook ────────────────────────────────────────────────────
const _origFetch = window.fetch;
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
  const res = await _origFetch(...args);
  if (url.includes('/api/timedtext')) {
    // 429 (or any 4xx/5xx) — same rate-limit back-off as the XHR hook.
    if (res.status >= 400) {
      lastRateLimitAt = Date.now();
      return res;
    }
    try {
      const text = await res.clone().text();
      if (text.length > 10) captureTimedText(url, text);
    } catch {
      /* ignore */
    }
  }
  return res;
};

// ── Track selection ──────────────────────────────────────────────
//
// Walk the player's tracklist, pick the best base track for the
// user's target lang, and request the two translations we need
// (target + display) so the overlay has both lines to render.

interface TrackInfo extends PickableTrack {
  name?: { simpleText?: string };
  translationLanguage?: { languageCode?: string };
}

interface YTPlayer {
  getOption?: (m: string, k: string) => unknown;
  setOption?: (m: string, k: string, v: unknown) => void;
  loadModule?: (m: string) => void;
  getPlayerResponse?: () => {
    videoDetails?: { videoId?: string };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          languageCode?: string;
          vssId?: string;
          kind?: string;
          isTranslatable?: boolean;
          name?: { simpleText?: string; runs?: Array<{ text?: string }> };
        }>;
        translationLanguages?: TranslationLanguageInfo[];
      };
    };
  };
}

/** Read the video's caption tracks. Current player builds return an
 *  EMPTY array from `getOption('captions','tracklist')` even while a
 *  track is actively rendering (observed 2026-07 — the option appears
 *  dead in the new player), which starved the whole selection pipeline:
 *  no resting pick, no menu, no cues. `getPlayerResponse()` still lists
 *  every track, and `setOption('captions','track', …)` happily accepts
 *  tracks built from those fields — so fall back to it. Guarded on the
 *  video id: during SPA navigation the response can briefly belong to
 *  the PREVIOUS video, and selecting its vssIds would silently fail. */
function readTracklist(player: YTPlayer): TrackInfo[] {
  try {
    const opt = player.getOption?.('captions', 'tracklist') as TrackInfo[] | undefined;
    if (opt?.length) return opt;
  } catch {
    /* fall through to the player response */
  }
  try {
    const resp = player.getPlayerResponse?.();
    const respVid = resp?.videoDetails?.videoId;
    if (respVid && respVid !== getVideoId()) return [];
    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return [];
    return tracks.map((t) => ({
      languageCode: t.languageCode,
      vssId: t.vssId,
      kind: t.kind,
      isTranslatable: t.isTranslatable,
      name: { simpleText: t.name?.simpleText || t.name?.runs?.[0]?.text || '' },
    }));
  } catch {
    return [];
  }
}

/** Same fallback for the auto-translate language list (the getOption
 *  read still works on current builds, but both live or die with the
 *  same captions module — keep them symmetric). */
function readTranslationLanguages(player: YTPlayer): TranslationLanguageInfo[] {
  try {
    const opt = player.getOption?.('captions', 'translationLanguages') as
      TranslationLanguageInfo[] | undefined;
    if (opt?.length) return opt;
  } catch {
    /* fall through to the player response */
  }
  try {
    return (
      player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer
        ?.translationLanguages || []
    );
  } catch {
    return [];
  }
}

/** Does this video have ANY caption track? Read from the player RESPONSE
 *  (not the lazy captions module `getOption` reads) so a CC-off video —
 *  whose module hasn't loaded and whose tracklist reads empty — isn't
 *  misjudged as caption-less. Returns:
 *    'has'     — at least one caption track exists (subtitles available);
 *    'none'    — response is loaded for THIS video and lists zero tracks
 *                (a genuinely subtitle-less video — stop hunting);
 *    'unknown' — response not loaded yet / stale during nav — keep trying. */
function captionAvailability(player: YTPlayer): 'has' | 'none' | 'unknown' {
  try {
    const resp = player.getPlayerResponse?.();
    const respVid = resp?.videoDetails?.videoId;
    // No response, or one that still belongs to the previous video during
    // an SPA navigation — can't conclude anything yet.
    if (!respVid || respVid !== getVideoId()) return 'unknown';
    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return tracks && tracks.length > 0 ? 'has' : 'none';
  } catch {
    return 'unknown';
  }
}

// ── Suppress YouTube's own rendering of a translated track ───────
//
// When we point the player at an AUTO-TRANSLATE track (a
// `translationLanguage` is set), YouTube renders that track itself.
// Its native rendering of a machine-translated track — especially one
// whose source is an auto-generated / undetermined-language ("und")
// caption — can pile the WHOLE transcript on screen at once instead of
// one timed line (reported 2026-07: "the CC shows ALL CC from the
// entire video"). Our overlay replaces that rendering, but only once it
// has parsed cues; in the gap (an empty / rate-limited timedtext body,
// or a dispatch that raced the overlay mount) YouTube's pile-up leaks
// through. So hide the native caption container for the entire time a
// translation is the active track, independent of whether our overlay
// has cues yet.
//
// Deliberately scoped to translations: a REAL (non-translated) track's
// native rendering is correct one-line captions and a perfectly good
// fallback while our cues load, so we leave it visible. The overlay's
// own cue-gated hide (content/YouTubeEnhancer.tsx) still covers that
// case; this MAIN-world hide is idempotent with it (same selectors,
// different <style> id — native CC stays hidden while EITHER is present).
const HIDE_STYLE_ID = 'tokori-yt-hide-translated-cc';
let nativeCcHidden = false;
function setNativeCcHidden(hidden: boolean) {
  if (hidden === nativeCcHidden) return;
  nativeCcHidden = hidden;
  try {
    const existing = document.getElementById(HIDE_STYLE_ID);
    if (!hidden) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    // textContent (not innerHTML) so youtube.com's Trusted Types policy
    // — `require-trusted-types-for 'script'` — never sees a guarded sink.
    style.textContent =
      '.ytp-caption-window-container,.caption-window,.ytp-caption-segment{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  } catch {
    /* head not ready / CSP — best effort, retried on the next set */
    nativeCcHidden = !hidden;
  }
}

/** Point the player at a caption track. All track selection goes through
 *  here so YouTube's native rendering of a translated track is hidden
 *  exactly while that track is active (see setNativeCcHidden) and the
 *  hide state can never drift from what the player is really showing. */
function setPlayerTrack(player: YTPlayer, track: unknown) {
  player.setOption?.('captions', 'track', track);
  const tl = (track as TrackInfo | null | undefined)?.translationLanguage?.languageCode;
  setNativeCcHidden(!!tl);
}

/** True while the "briefly switch to the translated track" excursion is
 *  running. The 700ms retry loop calls `selectForTarget` repeatedly —
 *  without this flag every tick re-activated the native track and
 *  stomped the in-flight translated fetch a previous tick had started,
 *  which is why the English line only sometimes loaded. */
let flipInFlight = false;
/** Whether the resting (native) track was activated this round. Set
 *  once, NOT gated on nativeCuesSent — the player may have fetched the
 *  native track before our hooks were installed, in which case those
 *  cues are unobservable until an excursion's restore refetches them. */
let restingSet = false;
/** When the resting track was last (re)activated — drives the
 *  Hant→Hans fallback timing. */
let restingSetAt = 0;
/** The Hant→Hans resting translation produced no cues and we dropped to
 *  the plain Traditional track. Sticky for the video (reset on nav /
 *  lang change, NOT on retry rounds — a translation that failed once
 *  will fail again). */
let restingFellBack = false;
/** Whatever resting track the player was last pointed at — excursion
 *  restores read this instead of a closure so a fallback that happens
 *  mid-excursion isn't undone by the restore. */
let currentRestingTrack: unknown = null;
/** Completed translated-track excursions this round — rotates the
 *  strategy below so one untranslatable track can't dead-end the line. */
let flipAttempts = 0;
/** Excursion budget for the WHOLE video (across retry rounds). Each
 *  flip costs two timedtext fetches (the flip + the restore's refetch)
 *  and YouTube rate-limits that endpoint aggressively — unbounded
 *  hunting when the EN line simply isn't available turned one failed
 *  video into a session-wide caption outage (rate-limited responses
 *  are empty, which reads as "still no cues", which kept the hunt
 *  going). Two full strategy rotations is plenty. */
const FLIP_BUDGET_PER_VIDEO = 6;
let flipsThisVideo = 0;
/** loadModule('captions') fired this round (once is enough — the module
 *  loads within a tick or two, or the video truly has no captions). */
let captionsModuleKicked = false;
/** When WE last pointed the player at a track (resting set, Hant
 *  fallback, excursion flip/restore). The subtitles-menu mirror below
 *  only trusts a differing track once the player has been quiet for a
 *  while — otherwise our own steering reads as a "user pick". */
let lastSteerAt = 0;
/** When a `/api/timedtext` fetch last came back HTTP 429 (or any 4xx/5xx).
 *  YouTube signs each track's timedtext URL with a single-use BotGuard
 *  `pot` token and rate-limits the endpoint hard: re-selecting a track the
 *  player already fetched re-issues the IDENTICAL signed URL, which 429s
 *  every time after the first. Our excursion flips (each costs a fetch +
 *  the restore's refetch) are the main source of that pressure, and a 429
 *  body is EMPTY — which the pipeline reads as "still no cues", driving yet
 *  more flips: one German-ASR video double-translated (→zh native, →en
 *  display) became a cascade of 429s. Inside the cooldown we suppress new
 *  flips entirely and lean on the retained-body replay instead of hammering
 *  the endpoint. NOT reset on same-video retry rounds (the pot token spans
 *  the whole video); cleared on navigation / language change (a new video
 *  mints a fresh pot). */
let lastRateLimitAt = 0;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
function rateLimited(): boolean {
  return lastRateLimitAt > 0 && Date.now() - lastRateLimitAt < RATE_LIMIT_COOLDOWN_MS;
}

/** Tell the overlay auto mode is standing down on this video (no
 *  target-language caption track): it drops any cue state, stops
 *  pinning its toolbar as "loading", and explains itself in the
 *  Subtitle menu instead of taking the video over. */
function announceHandsOff() {
  const vid = getVideoId();
  if (!vid) return;
  window.dispatchEvent(
    new CustomEvent('tokori-yt-track-status', {
      detail: {
        videoId: vid,
        engaged: false,
        reason: 'no-target-track',
        targetLang: currentTargetLang,
      },
    }),
  );
}

/** Auto mode found no target-language track: stand down for this video.
 *  Once per video we also UNDO any auto-translation the player is still
 *  sitting on — our own steering from a previous video (or an excursion
 *  cut short by navigation) can leave a machine-translated track
 *  active, and YouTube renders those itself, sometimes as the entire
 *  transcript piled on screen at once, with a "… → undefined" CC-menu
 *  entry. Resetting to the plain source track restores stock captions.
 *  A CC-off player reads no active track, so this never switches
 *  captions on against the user's wishes. */
function enterHandsOff(player: YTPlayer) {
  autoHandsOff = true;
  const vid = getVideoId();
  if (handsOffFor === vid) return;
  handsOffFor = vid;
  try {
    const cur = player.getOption?.('captions', 'track') as TrackInfo | undefined;
    if (cur?.translationLanguage?.languageCode) {
      const plain = (cur.vssId && readTracklist(player).find((t) => t.vssId === cur.vssId)) || null;
      if (plain) {
        setPlayerTrack(player, plain);
      } else {
        const rest: TrackInfo = { ...cur };
        delete rest.translationLanguage;
        setPlayerTrack(player, rest);
      }
    } else {
      // Nothing to undo — just make sure no stale translated-CC hide
      // outlives the round that owned it.
      setNativeCcHidden(false);
    }
  } catch {
    setNativeCcHidden(false);
  }
  announceHandsOff();
}

function selectForTarget(target: string) {
  // Respect an explicit CC-off: selecting a track would turn the
  // player's captions back on against the user's wishes. Same while
  // the overlay's OCR mode has selection suspended.
  if (ccUserOff || selectionSuspended) return false;
  // Never select against the placeholder 'en' target — wait for the
  // content script to report the real one (see targetSettled's grace).
  if (!targetSettled()) return false;
  // Snapshot the generation at the moment we kick off — the restore
  // timeout below checks against the live `selectionGen` so a stale
  // run (previous video / language) becomes a no-op.
  const gen = selectionGen;
  try {
    const player = document.getElementById('movie_player') as unknown as YTPlayer | null;
    if (!player?.getOption || !player.setOption) return false;
    const tracklist = readTracklist(player);
    if (!tracklist.length) {
      // A captioned video still reads an EMPTY tracklist while the
      // player's captions module isn't loaded — which is exactly the
      // state when the user's sticky CC preference is off. Kick the
      // module (harmless no-op on truly caption-less videos) so the
      // next retry tick can read the real list; without this, CC-off
      // page loads never show any subtitles at all.
      if (!captionsModuleKicked) {
        captionsModuleKicked = true;
        try {
          player.loadModule?.('captions');
        } catch {
          /* player variant without loadModule — nothing to kick */
        }
      }
      return false;
    }

    // Resting-source decision — target-language track first, the zh
    // Hant→Hans translation for a Traditional-only video, else NOTHING
    // (hands-off below — auto never translates other languages into
    // the target). The ladder lives in lib/yt-track-pick (pure,
    // unit-tested); the Hant→Hans rung is auto-mode only — a pinned
    // track is verbatim — and drops out once `restingFellBack` marks
    // it cue-less (Traditional captions beat no captions).
    const ov = nativeOverride;
    const plan = planRestingPick(tracklist, target, {
      resolveTlang: (l) => resolveTranslateCode(player, l),
      // The Hant→Hans rung also needs the player to actually OFFER a
      // Simplified translation — resting on an unlisted one shows no
      // cues for 6s until the timed fallback drops to plain
      // Traditional; skipping the rung gets there immediately.
      allowHantToHans: ov.mode === 'auto' && !restingFellBack && translationOffered(player, 'zh'),
    });
    const prefixMatch = plan.targetTrack;
    const base = plan.baseTrack;

    // A user-pinned choice from the overlay's subtitle menu takes over
    // the resting pick entirely — that's the whole point of the menu.
    let overrideResting: unknown = null;
    if (ov.mode === 'track') {
      const picked = tracklist.find((t) => t.vssId === ov.vssId);
      if (picked) overrideResting = picked;
    } else if (ov.mode === 'tlang') {
      const src = prefixMatch || base;
      if (src) overrideResting = makeTranslationTrack(player, src, ov.tlang);
    }

    // No pin and no target-language track: hands-off. Auto mode never
    // takes over a video that isn't in the workspace language.
    if (!overrideResting && !plan.resting) {
      enterHandsOff(player);
      return false;
    }
    autoHandsOff = false;

    const wantsHansTranslation = !overrideResting && plan.hantToHans;

    /** The track the player rests on (drives the native line). */
    const restingTrack =
      overrideResting ??
      (plan.resting!.mode === 'track'
        ? plan.resting!.track
        : makeTranslationTrack(player, plan.resting!.source, plan.resting!.tlang));

    // First tick of a round: activate the resting track so the native
    // line leads. Done exactly once — repeating it is a no-op for the
    // player (same track ⇒ no refetch), so it can never make progress
    // on its own and must not block the excursions below.
    if (!restingSet) {
      restingSet = true;
      restingSetAt = Date.now();
      lastSteerAt = Date.now();
      currentRestingTrack = restingTrack;
      setPlayerTrack(player, restingTrack);
      if (translationDisabled) {
        // With the EN line off there are no excursions — and the
        // excursion RESTORE's refetch is what normally recovers cues
        // when the resting track was already active (same-track
        // setOption doesn't refetch) or was fetched before our hooks
        // installed. Reload the caption track data outright instead.
        try {
          player.setOption('captions', 'reload', true);
        } catch {
          /* player build without the reload option */
        }
      }
      if (!overrideResting) publishAutoPick(restingTrack);
      return true;
    }

    // Hant→Hans resting didn't produce native cues in time (some tracks
    // refuse translation): fall back to the plain Traditional track once.
    if (
      !nativeCuesSent &&
      wantsHansTranslation &&
      prefixMatch &&
      Date.now() - restingSetAt > 6000
    ) {
      restingFellBack = true;
      restingSetAt = Date.now();
      lastSteerAt = Date.now();
      currentRestingTrack = prefixMatch;
      setPlayerTrack(player, prefixMatch);
      publishAutoPick(prefixMatch);
      return true;
    }

    // Hunt the translated line, one excursion at a time: switch to a
    // display-language source, give its fetch a full window, restore
    // the resting track (whose refetch also recovers native cues our
    // hooks missed at page load). Strategies rotate per attempt — the
    // same fallback ladder YouTube's own CC menu offers:
    //   1. auto-translate the native track,
    //   2. a REAL display-language track when the video has one,
    //   3. auto-translate the base (usually English/first) track.
    // Skipped entirely when the user turned the EN line off — the
    // excursions are the flicker-prone, fetch-heavy part — and once the
    // per-video budget is spent (the line isn't coming; stop hammering
    // the rate-limited timedtext endpoint).
    if (
      !translationDisabled &&
      !translatedCuesSent &&
      !flipInFlight &&
      !rateLimited() &&
      flipsThisVideo < FLIP_BUDGET_PER_VIDEO
    ) {
      const realDisplay = tracklist.find(
        (t) => !t.kind && matchesLang(t.languageCode || '', DISPLAY_LANG),
      );
      const displayCode = resolveTranslateCode(player, DISPLAY_LANG);
      // Translate excursions only when the player actually offers the
      // display language — an unlisted tlang fetches nothing and burns
      // the flip budget for it.
      const displayOffered = translationOffered(player, DISPLAY_LANG);
      const strategies: unknown[] = [];
      if (prefixMatch && displayOffered) {
        strategies.push(makeTranslationTrack(player, prefixMatch, displayCode));
      }
      if (realDisplay) strategies.push(realDisplay);
      if (base && base !== prefixMatch && displayOffered) {
        strategies.push(makeTranslationTrack(player, base, displayCode));
      }
      if (!strategies.length) return true;
      const flipTrack = strategies[flipAttempts % strategies.length];
      flipAttempts += 1;
      flipsThisVideo += 1;
      flipInFlight = true;
      lastSteerAt = Date.now();
      setPlayerTrack(player, flipTrack);
      window.setTimeout(() => {
        flipInFlight = false;
        if (gen !== selectionGen || ccUserOff) return;
        lastSteerAt = Date.now();
        setPlayerTrack(player, currentRestingTrack ?? restingTrack);
      }, 4000);
    }
    return true;
  } catch (e) {
    console.warn('[tokori-yt] selectForTarget error:', e);
    return false;
  }
}

/** Tell the overlay which entry the automatic pick resolved to
 *  (`track:<vssId>` for a real track, `tlang:<code>` for an
 *  auto-translation), so its Subtitle menu can land on the
 *  target-language entry instead of resting on an opaque "Auto".
 *  Reflection only — the overlay adopts the value without pinning, so
 *  this script's fallback ladder stays live. */
function publishAutoPick(resting: unknown) {
  const vid = getVideoId();
  if (!vid) return;
  const t = resting as TrackInfo;
  const tl = t.translationLanguage?.languageCode;
  window.dispatchEvent(
    new CustomEvent('tokori-yt-auto-pick', {
      detail: { videoId: vid, value: tl ? `tlang:${tl}` : `track:${t.vssId || ''}` },
    }),
  );
}

// ── Tracklist publishing ─────────────────────────────────────────
//
// The overlay's subtitle menu (the YouTube-CC-menu equivalent) needs to
// know which real tracks + auto-translate languages this video offers.
// Published once per video as `tokori-yt-tracks`, as soon as the
// player's tracklist becomes readable.

interface TranslationLanguageInfo {
  languageCode?: string;
  languageName?: { simpleText?: string } | string;
}

let tracksSentFor = '';
function publishTracks() {
  const vid = getVideoId();
  if (!vid || tracksSentFor === vid) return;
  try {
    const player = document.getElementById('movie_player') as unknown as YTPlayer | null;
    if (!player?.getOption) return;
    const tracklist = readTracklist(player);
    if (!tracklist.length) return;
    const translationLanguages = readTranslationLanguages(player);
    tracksSentFor = vid;
    window.dispatchEvent(
      new CustomEvent('tokori-yt-tracks', {
        detail: {
          videoId: vid,
          tracks: tracklist.map((t) => ({
            vssId: t.vssId || '',
            languageCode: t.languageCode || '',
            kind: t.kind || '',
            label:
              t.name?.simpleText ||
              (t.name as { runs?: Array<{ text?: string }> } | undefined)?.runs?.[0]?.text ||
              t.languageCode ||
              '',
          })),
          translationLanguages: translationLanguages
            .map((l) => ({
              code: l.languageCode || '',
              name:
                typeof l.languageName === 'string'
                  ? l.languageName
                  : l.languageName?.simpleText || l.languageCode || '',
            }))
            .filter((l) => l.code),
        },
      }),
    );
  } catch {
    /* tracklist not readable yet — the pollers retry */
  }
}

function poll() {
  const vid = getVideoId();
  if (!vid || vid === triggeredForVideo) return;
  triggeredForVideo = vid;
  nativeCuesSent = false;
  translatedCuesSent = false;
  // Fresh selection round: re-arm the resting-track set + strategy
  // rotation (also entered for the bounded same-video retry rounds).
  restingSet = false;
  flipAttempts = 0;
  captionsModuleKicked = false;
  captionsUnavailable = false;
  // Fresh round: drop any leftover "hide YouTube's translated captions"
  // style from the previous selection. The first track this round sets
  // re-applies it only if that track is itself an auto-translation, so a
  // real-track video doesn't inherit a hidden native line.
  setNativeCcHidden(false);
  // Invalidate any in-flight staggered-flip timeouts from a previous
  // video — they'd otherwise reach into the new video's player state.
  selectionGen += 1;
  let n = 0;
  if (selectionRetryTimer) window.clearInterval(selectionRetryTimer);
  selectionRetryTimer = window.setInterval(() => {
    n += 1;
    if (n > 30 || (nativeCuesSent && (translatedCuesSent || translationDisabled))) {
      if (selectionRetryTimer) window.clearInterval(selectionRetryTimer);
      selectionRetryTimer = null;
      return;
    }
    // Early bail on a genuinely caption-less video: once the player
    // response is loaded (short grace so we don't race its init) and lists
    // zero caption tracks, no amount of retrying will produce cues — stop
    // the spin instead of "loading" for 20s+. A late-arriving track flips
    // this back to 'has' before the grace elapses, so a slow tracklist
    // isn't misjudged. OCR mode is unaffected (it never used this loop).
    if (n >= 3) {
      const p = document.getElementById('movie_player') as unknown as YTPlayer | null;
      if (p && captionAvailability(p) === 'none') {
        captionsUnavailable = true;
        if (selectionRetryTimer) window.clearInterval(selectionRetryTimer);
        selectionRetryTimer = null;
        return;
      }
    }
    // Serve anything the player already fetched (and we retained) before
    // the target settled / a pin landed — this alone recovers the common
    // "player loaded captions before the overlay was ready" case without
    // needing a single excursion refetch.
    redispatchCaptured();
    publishTracks();
    selectForTarget(currentTargetLang);
    // Hands-off conclusion (tracks loaded, none in the target language):
    // the tracklist won't grow one, so further retries can't change the
    // answer. Stop the spin — a Subtitle-menu pin or a target-language
    // change re-runs poll() explicitly.
    if (autoHandsOff && selectionRetryTimer) {
      window.clearInterval(selectionRetryTimer);
      selectionRetryTimer = null;
    }
  }, 700);

  const startedFor = vid;
  window.setTimeout(() => {
    // A subtitle-less (or hands-off) video has nothing to wait for —
    // don't schedule the extra rounds (and leave the lock in place so
    // the 1s fallback poll doesn't restart the spin either).
    if (captionsUnavailable || autoHandsOff) return;
    if (!translatedCuesSent && !translationDisabled && triggeredForVideo === startedFor) {
      // Release the lock so a retry can fire on the next nav.
      triggeredForVideo = '';
      // And give THIS video a couple more full rounds — a buffering
      // player or slow network can outlast the first retry window,
      // which used to leave the translated line missing until the user
      // navigated away and back.
      if (!ccUserOff && retryRounds < 2) {
        retryRounds += 1;
        window.setTimeout(poll, 500);
      }
    }
  }, 25_000);
}

// Initial probe — but only after the tracklist has had a moment to load.
window.setTimeout(poll, 2000);

// Re-fire on SPA navigation: YouTube changes the URL but doesn't reload
// the page, so we poll the video id every second AND listen for the
// `yt-navigate-finish` event for an instant trigger.
let _lastVid = getVideoId();
window.setInterval(() => {
  const cur = getVideoId();
  if (cur && cur !== _lastVid) {
    _lastVid = cur;
    capturedByUrl.clear();
    setNativeCcHidden(false);
    triggeredForVideo = '';
    nativeCuesSent = false;
    translatedCuesSent = false;
    // A new video is a fresh start — the CC-off veto was for the
    // previous video's captions, a pinned track's vssId doesn't exist
    // on the new video, and the overlay resets OCR mode to Auto.
    ccUserOff = false;
    selectionSuspended = false;
    flipInFlight = false;
    retryRounds = 0;
    flipsThisVideo = 0;
    restingFellBack = false;
    lastRateLimitAt = 0;
    captionsUnavailable = false;
    autoHandsOff = false;
    handsOffFor = '';
    nativeOverride = { mode: 'auto' };
    window.setTimeout(poll, 2000);
  } else if (
    cur &&
    !triggeredForVideo &&
    !selectionRetryTimer &&
    !ccUserOff &&
    !selectionSuspended &&
    retryRounds < 2
  ) {
    // On a watch page whose selection round never ran: the id didn't
    // change (so the branch above stays quiet) but nothing is armed
    // either — e.g. the target language changed while off-watch
    // (poll() bails without a video id), or a navigation event was
    // missed. Without this, captions stay dead until the user opens a
    // DIFFERENT video. The retryRounds cap keeps caption-less videos
    // from re-polling forever.
    poll();
  }
}, 1000);

window.addEventListener('yt-navigate-finish', () => {
  const cur = getVideoId();
  if (cur && cur !== _lastVid) {
    _lastVid = cur;
    capturedByUrl.clear();
    setNativeCcHidden(false);
    triggeredForVideo = '';
    nativeCuesSent = false;
    translatedCuesSent = false;
    // A new video is a fresh start — the CC-off veto was for the
    // previous video's captions, a pinned track's vssId doesn't exist
    // on the new video, and the overlay resets OCR mode to Auto.
    ccUserOff = false;
    selectionSuspended = false;
    flipInFlight = false;
    retryRounds = 0;
    flipsThisVideo = 0;
    restingFellBack = false;
    lastRateLimitAt = 0;
    captionsUnavailable = false;
    autoHandsOff = false;
    handsOffFor = '';
    nativeOverride = { mode: 'auto' };
    window.setTimeout(poll, 2000);
  }
});

// Content script tells us the user's chosen target language. Re-poll
// so we re-select tracks for the new target (Chinese first, fallback
// auto-translate, etc.).
window.addEventListener('tokori-yt-set-target-lang', ((e: Event) => {
  const ce = e as CustomEvent<{ lang?: string }>;
  const lang = (ce.detail?.lang || '').toLowerCase().trim();
  if (lang.length < 2) return;
  // Selection + classification are held until the real target is known
  // — mark ready even when the reported language equals the default, or
  // an English learner would sit out the whole 8s grace for nothing.
  targetLangReady = true;
  if (lang === currentTargetLang) return;
  currentTargetLang = lang;
  // Force re-selection on the current video and stamp out any
  // still-pending track flips from the previous language — without
  // the gen bump those would fire ~3s later and briefly steer YT to
  // the old track, sending mismatched cues to the overlay. A pinned
  // track choice belongs to the previous target, so it resets too.
  triggeredForVideo = '';
  nativeCuesSent = false;
  translatedCuesSent = false;
  selectionGen += 1;
  flipInFlight = false;
  retryRounds = 0;
  flipsThisVideo = 0;
  restingFellBack = false;
  // New target ⇒ different tlang ⇒ different signed timedtext URLs, not
  // yet rate-limited — let the fresh round try them.
  lastRateLimitAt = 0;
  captionsUnavailable = false;
  // A different target may well exist on this video — re-evaluate the
  // hands-off conclusion (and re-announce it if it still holds).
  autoHandsOff = false;
  handsOffFor = '';
  nativeOverride = { mode: 'auto' };
  // The overlay resets its track choice (incl. OCR) on a language
  // change — selection resumes for the new target.
  selectionSuspended = false;
  window.setTimeout(poll, 100);
}) as EventListener);

// Overlay EN pill → "off": the user wants no display-language line at
// all. Mid-video re-enable re-runs a selection round so the translated
// track gets hunted after all.
window.addEventListener('tokori-yt-set-translation', ((e: Event) => {
  const enabled = !!(e as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
  if (!enabled === translationDisabled) return;
  translationDisabled = !enabled;
  if (enabled && !translatedCuesSent && !ccUserOff && !selectionSuspended) {
    triggeredForVideo = '';
    window.setTimeout(poll, 100);
  }
}) as EventListener);

// Overlay subtitle menu: pin a specific real track / auto-translate lang
// as the native-line source, suspend selection entirely (OCR mode), or
// return to the automatic pick. Same reset dance as a target-language
// change so the fresh selection round starts clean and stale flips
// can't pollute the streams.
window.addEventListener('tokori-yt-set-track', ((e: Event) => {
  const ce = e as CustomEvent<{ mode?: string; vssId?: string; lang?: string; tlang?: string }>;
  const d = ce.detail || {};
  if (d.mode === 'suspend') {
    // OCR mode: freeze everything, exactly like a user CC-off — no
    // retry loop, no staggered flips, no cue dispatches.
    selectionSuspended = true;
    // OCR (or CC-off) owns the overlay now — we're not translating, so
    // drop the native-caption hide.
    setNativeCcHidden(false);
    selectionGen += 1;
    flipInFlight = false;
    if (selectionRetryTimer) {
      window.clearInterval(selectionRetryTimer);
      selectionRetryTimer = null;
    }
    return;
  }
  selectionSuspended = false;
  // Picking a subtitle source is an explicit "captions on" — lift any
  // standing CC-off veto, or the fresh round below selects nothing.
  ccUserOff = false;
  if (d.mode === 'track' && d.vssId) {
    nativeOverride = { mode: 'track', vssId: d.vssId, lang: (d.lang || '').toLowerCase() };
  } else if (d.mode === 'tlang' && d.tlang) {
    nativeOverride = { mode: 'tlang', tlang: d.tlang };
  } else {
    nativeOverride = { mode: 'auto' };
  }
  triggeredForVideo = '';
  nativeCuesSent = false;
  translatedCuesSent = false;
  selectionGen += 1;
  flipInFlight = false;
  retryRounds = 0;
  flipsThisVideo = 0;
  restingFellBack = false;
  // A pin engages us regardless of the tracklist; picking Auto back
  // re-evaluates (and re-announces) the hands-off conclusion.
  autoHandsOff = false;
  handsOffFor = '';
  window.setTimeout(poll, 100);
}) as EventListener);

// Overlay (content script) mounted / re-mounted and wants whatever we
// already have. This script runs at document_start and can capture +
// dispatch a video's cues, tracks, and auto-pick BEFORE the React
// overlay (document_idle) has added its listeners — those first
// dispatches land in the void and, because the once-flags were spent,
// were never re-emitted: captions simply never appeared until a
// navigation. On request we re-publish the tracklist and re-serve the
// retained cue bodies (bypassing the once-flags, since the whole point
// is that the first emit was missed). Mirrors the Netflix/Disney
// `request-tracks` replay.
window.addEventListener('tokori-yt-request-replay', () => {
  tracksSentFor = '';
  publishTracks();
  if (currentRestingTrack) publishAutoPick(currentRestingTrack);
  // A freshly mounted overlay defaults to "engaged" — repeat the
  // hands-off verdict or it would pin its toolbar as loading forever.
  if (autoHandsOff) announceHandsOff();
  nativeCuesSent = false;
  translatedCuesSent = false;
  redispatchCaptured();
});

// ── Mirror YouTube's CC button state ─────────────────────────────
//
// The user can toggle YouTube's own CC button (.ytp-subtitles-button).
// We poll its `aria-pressed` attribute every 400ms and dispatch
// `tokori-yt-cc-state` with the current enabled flag — the React
// overlay listens for that and hides itself when CC is off, so our
// custom captions disappear in lockstep with the player's.
//
// This toggle mirror deliberately does NOT read
// `getOption('captions', 'track')`: our own track-switching plays games
// with that option and it would flip the perceived state every few
// seconds. The subtitles-MENU mirror below does poll it, but only once
// the steering has been quiet long enough to trust what it reads.
let lastCcEnabled: boolean | null = null;
let lastCcAbsent: boolean | null = null;
/** Which video the readings above belong to + when it changed. An
 *  on→off transition only counts as the USER dismissing captions when
 *  both readings came from the SAME video, past a settling window:
 *  during SPA navigation the player re-initializes and re-applies the
 *  sticky CC preference, and that pressed→unpressed flip can land
 *  AFTER the nav handlers reset `ccUserOff` — misread as a user veto,
 *  it froze all track selection for the new video ("menu stuck on
 *  Auto, no subtitles at all" until the user clicked CC by hand). */
let ccStateVid = '';
let ccStateVidAt = 0;
/** A real user gesture on the CC toggle (button click / "c" shortcut)
 *  just happened — an on→off inside the settling window is honored as
 *  a genuine dismissal when it follows one of these. */
let ccToggleGestureAt = 0;
function pollCcButtonState() {
  // Piggy-back the tracklist publish on this cheap poll — the selection
  // retry loop stops once cues are flowing, but a late-loading
  // tracklist (or a CC-off video) should still populate the subtitle menu.
  publishTracks();
  // Scope to the main player — hover previews / miniplayers mount their
  // own `.ytp-subtitles-button`, and a bare querySelector can land on
  // one of those and report the wrong state.
  const btn =
    document.querySelector<HTMLButtonElement>('#movie_player .ytp-subtitles-button') ||
    document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  if (!btn) return;
  // New video (or off-watch page): the previous readings belong to
  // another player state — start from a clean baseline so a flip
  // spanning two videos can never register as a transition.
  const vid = getVideoId();
  if (vid !== ccStateVid) {
    ccStateVid = vid;
    ccStateVidAt = Date.now();
    lastCcEnabled = null;
    lastCcAbsent = null;
  }
  // Videos with no caption tracks keep the button in the DOM but
  // hidden (display:none ⇒ zero size), stuck at aria-pressed=false.
  // That is NOT the user dismissing captions — report it as "no CC
  // control" so the overlay stays reachable (it's exactly where the
  // burned-in-subtitle OCR mode is needed).
  const absent = btn.offsetWidth === 0 && btn.offsetHeight === 0;
  const enabled = absent ? true : btn.getAttribute('aria-pressed') === 'true';
  if (enabled !== lastCcEnabled || absent !== lastCcAbsent) {
    const wasEnabled = lastCcEnabled;
    lastCcEnabled = enabled;
    lastCcAbsent = absent;
    // Inside the post-navigation settling window an on→off flip is the
    // player re-applying its sticky CC preference, not the user — the
    // veto below would freeze track selection for the whole video.
    // A real CC gesture (button click / "c") overrides the window.
    const settling = Date.now() - ccStateVidAt < 5000 && Date.now() - ccToggleGestureAt > 1000;
    if (wasEnabled === true && !enabled && vid && !settling) {
      // Genuine on→off transition — the user dismissed captions.
      // Freeze all track selection: stop the retry loop and invalidate
      // any staggered translated-track flips already queued, otherwise
      // they'd call setOption a moment later and switch CC back on.
      ccUserOff = true;
      // Captions are being dismissed — release our translated-CC hide so
      // it can't outlive the round that owned it.
      setNativeCcHidden(false);
      selectionGen += 1;
      flipInFlight = false;
      if (selectionRetryTimer) {
        window.clearInterval(selectionRetryTimer);
        selectionRetryTimer = null;
      }
    } else if (enabled && ccUserOff) {
      // User turned CC back on. Resume our track handling; if the cue
      // streams never finished loading for this video, re-run selection
      // so the overlay comes back with the right tracks.
      ccUserOff = false;
      if (!nativeCuesSent || (!translatedCuesSent && !translationDisabled)) {
        triggeredForVideo = '';
        window.setTimeout(poll, 100);
      }
    } else if (
      enabled &&
      wasEnabled === false &&
      !nativeCuesSent &&
      !selectionRetryTimer &&
      !selectionSuspended
    ) {
      // CC flipped on without a user-off veto in place — e.g. the user
      // enabling captions on a page that LOADED with their sticky CC
      // preference off, after our bounded retry rounds already gave up
      // (the captions module reads an empty tracklist until it loads).
      // No live round is running, so start one.
      triggeredForVideo = '';
      window.setTimeout(poll, 100);
    }
    window.dispatchEvent(new CustomEvent('tokori-yt-cc-state', { detail: { enabled, absent } }));
  }
}
window.setInterval(pollCcButtonState, 400);
window.setTimeout(pollCcButtonState, 1500);
// React to the gesture itself too — the 400ms poll alone leaves a beat
// where our overlay lingers after the native CC visibly toggled. The
// gesture timestamp also marks the next observed flip as user-made
// (see the settling window above).
document.addEventListener(
  'click',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('.ytp-subtitles-button')) {
      ccToggleGestureAt = Date.now();
      window.setTimeout(pollCcButtonState, 0);
    }
  },
  true,
);
// YouTube's "c" shortcut toggles captions without a click.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"], #contenteditable-root'))
      return;
    ccToggleGestureAt = Date.now();
    window.setTimeout(pollCcButtonState, 0);
  },
  true,
);

// ── Mirror YouTube's own subtitles MENU ──────────────────────────
//
// Picking a track (or auto-translate language) in the player's native
// settings menu must not fight the overlay: without this, the pick was
// either ignored (its cues match neither target nor display language,
// so they were classified away while the overlay kept showing the old
// track — and our CSS hides YT's own rendering) or reverted by the
// next excursion restore. Detect it and adopt it exactly like a pick
// from the overlay's Subtitle menu, so the two menus always agree.
//
// Detection is deliberately paranoid — a false positive would pin the
// wrong track and kill the automatic fallbacks:
//   • only while selection is settled (cues sent, no live round, no
//     flip in flight, >6s since we last steered the player);
//   • the read track must differ from our resting pick AND belong to
//     this video's tracklist / translate menu (ads fail this);
//   • two consecutive identical reads (~1.6s) before adopting.
const menuTrackKey = (t: unknown): string => {
  const x = (t ?? {}) as TrackInfo;
  return `${x.vssId || ''}|${x.translationLanguage?.languageCode || ''}`;
};
let lastMenuKey = '';
let menuKeyStreak = 0;
function pollNativeMenuPick() {
  if (ccUserOff || selectionSuspended || !targetSettled()) return;
  if (!nativeCuesSent || triggeredForVideo !== getVideoId()) return;
  if (selectionRetryTimer || flipInFlight || Date.now() - lastSteerAt < 6000) {
    menuKeyStreak = 0;
    return;
  }
  try {
    const player = document.getElementById('movie_player') as unknown as YTPlayer | null;
    const cur = player?.getOption?.('captions', 'track') as TrackInfo | undefined;
    const tl = cur?.translationLanguage?.languageCode || '';
    if (!cur || (!cur.vssId && !tl)) return;
    const curKey = menuTrackKey(cur);
    if (curKey === menuTrackKey(currentRestingTrack)) {
      menuKeyStreak = 0;
      lastMenuKey = curKey;
      return;
    }
    if (curKey !== lastMenuKey) {
      lastMenuKey = curKey;
      menuKeyStreak = 1;
      return;
    }
    if (++menuKeyStreak < 2) return;
    menuKeyStreak = 0;
    // Legitimacy check against this video's own offerings.
    const tracklist = player ? readTracklist(player) : [];
    const translations = player ? readTranslationLanguages(player) : [];
    const listed = tl
      ? translations.some((l) => l.languageCode === tl)
      : tracklist.some((t) => t.vssId && t.vssId === cur.vssId);
    if (!listed) return;

    // Adopt as a user pin — same semantics as the overlay's menu.
    nativeOverride = tl
      ? { mode: 'tlang', tlang: tl }
      : { mode: 'track', vssId: cur.vssId || '', lang: (cur.languageCode || '').toLowerCase() };
    currentRestingTrack = cur;
    window.dispatchEvent(
      new CustomEvent('tokori-yt-external-pick', {
        detail: { videoId: getVideoId(), value: tl ? `tlang:${tl}` : `track:${cur.vssId || ''}` },
      }),
    );
    // Same reset dance as an overlay pick: classification and the EN
    // line re-run against the new source, and the excursion restore's
    // refetch repopulates the overlay even though the player won't
    // refetch a track it is already on.
    triggeredForVideo = '';
    nativeCuesSent = false;
    translatedCuesSent = false;
    selectionGen += 1;
    flipInFlight = false;
    retryRounds = 0;
    flipsThisVideo = 0;
    restingFellBack = false;
    window.setTimeout(poll, 100);
  } catch {
    /* player mid-rebuild — next poll retries */
  }
}
window.setInterval(pollNativeMenuPick, 800);
