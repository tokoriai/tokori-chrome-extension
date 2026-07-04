/// <reference lib="dom" />

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
 *   3. If no matching native track exists, we auto-translate from the
 *      first English (or first available) track using YouTube's
 *      `tlang=` machine-translation. This is the "fallback to auto-
 *      translate CC" path.
 *   4. In parallel we always trigger a translation to the display
 *      language (English for now) for the second/translated line.
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
  // 8s grace: if no event ever arrives (extension surface not mounted),
  // fall back to the default so plain-English users still get captions.
  return targetLangReady || Date.now() - SCRIPT_START > 8000;
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
    const list = player.getOption?.('captions', 'translationLanguages') as
      Array<{ languageCode?: string }> | undefined;
    const codes = (list || []).map((l) => l.languageCode || '').filter(Boolean);
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

const SIMPLIFIED_CODES = ['zh', 'zh-hans', 'zh-cn', 'zh-sg', 'zh-my'];
const TRADITIONAL_CODES = ['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'];

let nativeCuesSent = false;
let translatedCuesSent = false;
let triggeredForVideo = '';
let selectionRetryTimer: number | null = null;
/** Set when the user turns the player's CC button off. While true, all
 *  track selection is suspended — the selection retry loop and the
 *  staggered "grab the translated track" flips would otherwise call
 *  `setOption('captions', …)`, which re-enables captions and makes the
 *  overlay pop right back after the user dismissed it. Cleared when the
 *  user turns CC back on or a new video starts. */
let ccUserOff = false;
/** Extra full retry rounds already spent on the current video (see the
 *  25s release timeout in `poll`). Reset on navigation / lang change. */
let retryRounds = 0;
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

function parseSrv3(xml: string): TimedCue[] {
  const cues: TimedCue[] = [];
  new DOMParser()
    .parseFromString(xml, 'text/xml')
    .querySelectorAll('text')
    .forEach((el) => {
      const text = (el.textContent || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
      if (text) {
        cues.push({
          start: parseFloat(el.getAttribute('start') || '0'),
          dur: parseFloat(el.getAttribute('dur') || '0'),
          text,
        });
      }
    });
  return cues;
}

function textToCues(text: string): TimedCue[] {
  if (!text || text.length < 10) return [];
  try {
    const c = parseEventsJson(JSON.parse(text));
    if (c.length) return c;
  } catch {}
  try {
    const c = parseSrv3(text);
    if (c.length) return c;
  } catch {}
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

function matchesLang(actual: string, target: string): boolean {
  const a = actual.toLowerCase();
  const t = target.toLowerCase();
  if (!a || !t) return false;
  if (a === t) return true;
  // YouTube uses zh-CN / zh-TW / zh-Hans / pt-BR / etc. — match by prefix.
  if (a.startsWith(t + '-') || a.startsWith(t + '_')) return true;
  if (t.startsWith(a + '-') || t.startsWith(a + '_')) return true;
  // Cross-script Chinese: target 'zh' should accept 'zh-Hans' etc., which
  // the above covers. Treat 'zh-Hans' / 'zh-Hant' / 'zh-CN' / 'zh-TW' as
  // interchangeable when target is just 'zh'.
  if (t === 'zh' && a.startsWith('zh')) return true;
  if (a === 'zh' && t.startsWith('zh')) return true;
  return false;
}

function dispatchCues(url: string, text: string) {
  // Don't classify against the placeholder target — YT often fetches an
  // English track on its own at load (user's CC preference), and with
  // the default target 'en' that would dispatch English as "native".
  if (!targetSettled()) return;
  const kind = classify(url);
  if (!kind) return;
  const cues = textToCues(text);
  if (cues.length === 0) return;
  if (kind === 'native' && !nativeCuesSent) {
    window.dispatchEvent(new CustomEvent('tokori-yt-native-cues', { detail: { cues, url } }));
    nativeCuesSent = true;
  }
  if (kind === 'translated' && !translatedCuesSent) {
    window.dispatchEvent(new CustomEvent('tokori-yt-translated-cues', { detail: { cues, url } }));
    translatedCuesSent = true;
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
      dispatchCues(url, xhr.responseText || '');
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
    try {
      const text = await res.clone().text();
      if (text.length > 10) dispatchCues(url, text);
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

interface TrackInfo {
  languageCode?: string;
  vssId?: string;
  kind?: string;
  name?: { simpleText?: string };
  translationLanguage?: { languageCode?: string };
}

interface YTPlayer {
  getOption?: (m: string, k: string) => unknown;
  setOption?: (m: string, k: string, v: unknown) => void;
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

function selectForTarget(target: string) {
  // Respect an explicit CC-off: selecting a track would turn the
  // player's captions back on against the user's wishes.
  if (ccUserOff) return false;
  // Never select against the placeholder 'en' target — wait for the
  // content script to report the real one (8s grace, see targetSettled).
  if (!targetSettled()) return false;
  // Snapshot the generation at the moment we kick off — the restore
  // timeout below checks against the live `selectionGen` so a stale
  // run (previous video / language) becomes a no-op.
  const gen = selectionGen;
  try {
    const player = document.getElementById('movie_player') as unknown as YTPlayer | null;
    if (!player?.getOption || !player.setOption) return false;
    const tracklist = player.getOption('captions', 'tracklist') as TrackInfo[] | undefined;
    if (!tracklist?.length) return false;

    // Look for a real native track in the target language (exact, then
    // prefix); otherwise fall back to auto-translating a base track.
    // Chinese gets script-aware ordering: a Simplified track wins over
    // Traditional variants when both exist.
    const lower = (t: TrackInfo) => (t.languageCode || '').toLowerCase();
    const exactMatch = tracklist.find((t) => lower(t) === target);
    const scriptPreferred =
      target === 'zh' ? tracklist.find((t) => SIMPLIFIED_CODES.includes(lower(t))) : undefined;
    const prefixMatch =
      exactMatch || scriptPreferred || tracklist.find((t) => matchesLang(lower(t), target));
    const base = tracklist.find((t) => lower(t).startsWith('en')) || tracklist[0];
    if (!prefixMatch && !base) return false;

    // Only a Traditional track for a "zh" learner? Rest on YouTube's own
    // "Chinese (Traditional) → Chinese (Simplified)" translation — the
    // same option the player's CC menu offers — so the native line
    // matches the learner's script, dictionaries, and workspace. If that
    // translation never yields cues, `restingFellBack` drops us to the
    // plain Traditional track after a few seconds (Traditional captions
    // beat no captions).
    const wantsHansTranslation =
      !restingFellBack &&
      target === 'zh' &&
      !!prefixMatch &&
      TRADITIONAL_CODES.includes(lower(prefixMatch));

    /** The track the player rests on (drives the native line). */
    const restingTrack = prefixMatch
      ? wantsHansTranslation
        ? {
            ...prefixMatch,
            translationLanguage: { languageCode: resolveTranslateCode(player, 'zh') },
          }
        : prefixMatch
      : {
          ...base,
          translationLanguage: { languageCode: resolveTranslateCode(player, target) },
        };

    // First tick of a round: activate the resting track so the native
    // line leads. Done exactly once — repeating it is a no-op for the
    // player (same track ⇒ no refetch), so it can never make progress
    // on its own and must not block the excursions below.
    if (!restingSet) {
      restingSet = true;
      restingSetAt = Date.now();
      currentRestingTrack = restingTrack;
      player.setOption('captions', 'track', restingTrack);
      return true;
    }

    // Hant→Hans resting didn't produce native cues in time (some tracks
    // refuse translation): fall back to the plain Traditional track once.
    if (!nativeCuesSent && wantsHansTranslation && Date.now() - restingSetAt > 6000) {
      restingFellBack = true;
      restingSetAt = Date.now();
      currentRestingTrack = prefixMatch;
      player.setOption('captions', 'track', prefixMatch);
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
    if (!translatedCuesSent && !flipInFlight) {
      const realDisplay = tracklist.find(
        (t) => !t.kind && matchesLang(t.languageCode || '', DISPLAY_LANG),
      );
      const displayCode = resolveTranslateCode(player, DISPLAY_LANG);
      const strategies: unknown[] = [];
      if (prefixMatch) {
        strategies.push({
          ...prefixMatch,
          translationLanguage: { languageCode: displayCode },
        });
      }
      if (realDisplay) strategies.push(realDisplay);
      if (base && base !== prefixMatch) {
        strategies.push({ ...base, translationLanguage: { languageCode: displayCode } });
      }
      if (!strategies.length) return true;
      const flipTrack = strategies[flipAttempts % strategies.length];
      flipAttempts += 1;
      flipInFlight = true;
      player.setOption('captions', 'track', flipTrack);
      window.setTimeout(() => {
        flipInFlight = false;
        if (gen !== selectionGen || ccUserOff) return;
        player.setOption?.('captions', 'track', currentRestingTrack ?? restingTrack);
      }, 4000);
    }
    return true;
  } catch (e) {
    console.warn('[tokori-yt] selectForTarget error:', e);
    return false;
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
  // Invalidate any in-flight staggered-flip timeouts from a previous
  // video — they'd otherwise reach into the new video's player state.
  selectionGen += 1;
  let n = 0;
  if (selectionRetryTimer) window.clearInterval(selectionRetryTimer);
  selectionRetryTimer = window.setInterval(() => {
    n += 1;
    if (n > 30 || (nativeCuesSent && translatedCuesSent)) {
      if (selectionRetryTimer) window.clearInterval(selectionRetryTimer);
      selectionRetryTimer = null;
      return;
    }
    selectForTarget(currentTargetLang);
  }, 700);

  const startedFor = vid;
  window.setTimeout(() => {
    if (!translatedCuesSent && triggeredForVideo === startedFor) {
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
    triggeredForVideo = '';
    nativeCuesSent = false;
    translatedCuesSent = false;
    // A new video is a fresh start — the CC-off veto was for the
    // previous video's captions.
    ccUserOff = false;
    flipInFlight = false;
    retryRounds = 0;
    restingFellBack = false;
    window.setTimeout(poll, 2000);
  }
}, 1000);

window.addEventListener('yt-navigate-finish', () => {
  const cur = getVideoId();
  if (cur && cur !== _lastVid) {
    _lastVid = cur;
    triggeredForVideo = '';
    nativeCuesSent = false;
    translatedCuesSent = false;
    // A new video is a fresh start — the CC-off veto was for the
    // previous video's captions.
    ccUserOff = false;
    flipInFlight = false;
    retryRounds = 0;
    restingFellBack = false;
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
  // the old track, sending mismatched cues to the overlay.
  triggeredForVideo = '';
  nativeCuesSent = false;
  translatedCuesSent = false;
  selectionGen += 1;
  flipInFlight = false;
  retryRounds = 0;
  restingFellBack = false;
  window.setTimeout(poll, 100);
}) as EventListener);

// ── Mirror YouTube's CC button state ─────────────────────────────
//
// The user can toggle YouTube's own CC button (.ytp-subtitles-button).
// We poll its `aria-pressed` attribute every 400ms and dispatch
// `tokori-yt-cc-state` with the current enabled flag — the React
// overlay listens for that and hides itself when CC is off, so our
// custom captions disappear in lockstep with the player's.
//
// We deliberately do NOT poll `getOption('captions', 'track')` here:
// our own track-switching plays games with that option and it would
// flip the perceived state every few seconds.
let lastCcEnabled: boolean | null = null;
function pollCcButtonState() {
  // Scope to the main player — hover previews / miniplayers mount their
  // own `.ytp-subtitles-button`, and a bare querySelector can land on
  // one of those and report the wrong state.
  const btn =
    document.querySelector<HTMLButtonElement>('#movie_player .ytp-subtitles-button') ||
    document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  if (!btn) return;
  const enabled = btn.getAttribute('aria-pressed') === 'true';
  if (enabled !== lastCcEnabled) {
    const wasEnabled = lastCcEnabled;
    lastCcEnabled = enabled;
    if (wasEnabled === true && !enabled) {
      // Genuine on→off transition — the user dismissed captions.
      // Freeze all track selection: stop the retry loop and invalidate
      // any staggered translated-track flips already queued, otherwise
      // they'd call setOption a moment later and switch CC back on.
      ccUserOff = true;
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
      if (!nativeCuesSent || !translatedCuesSent) {
        triggeredForVideo = '';
        window.setTimeout(poll, 100);
      }
    }
    window.dispatchEvent(new CustomEvent('tokori-yt-cc-state', { detail: { enabled } }));
  }
}
window.setInterval(pollCcButtonState, 400);
window.setTimeout(pollCcButtonState, 1500);
// React to the click itself too — the 400ms poll alone leaves a beat
// where our overlay lingers after the native CC visibly toggled.
document.addEventListener(
  'click',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('.ytp-subtitles-button')) window.setTimeout(pollCcButtonState, 0);
  },
  true,
);
