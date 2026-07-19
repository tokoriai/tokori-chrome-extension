/**
 * MV3 service worker — message router between content scripts, popup,
 * options page, and the lib modules.
 *
 * Pattern lifted from hanpanda: each handler is a top-level `if` on
 * `request.action`, returns `true` to keep the message channel open
 * for async responses. Cross-cutting cached state (mode, anki) is
 * hydrated on boot from chrome.storage.local and refreshed via
 * `storage.onChanged`.
 */

import {
  detectAnki,
  ac,
  getAnkiMode,
  addNote,
  storeMediaFile,
  makeMediaFilename,
  stripDataUrl,
  type AddNoteInput,
} from './lib/anki';
import { buildAnkiFields, mimeToExt } from './lib/anki-fields';
import { installMigakuPreset } from './lib/anki-presets';
import {
  DEFAULT_SETTINGS,
  getSettings,
  patchSettings,
  getTabOverride,
  setTabOverride,
  resolveSaveTargets,
  CLOUD_ONLY_ERROR,
  type Mode,
} from './lib/settings';
import {
  freeTranslate,
  explain,
  chatOnce,
  visionOnce,
  buildDefinePrompt,
  parseDefineResponse,
} from './lib/ai-providers';
import { debug, warn } from './lib/log';
import { detectLanguage, getLanguage, type LanguageCode } from './lib/languages';
import { tesseractLangFor } from './lib/ocr-cues';
import {
  lookup as localDictLookup,
  listMeta,
  deleteDict,
  upsertPersonalEntry,
  type DictEntry,
} from './lib/dictionaries/idb';
import { packById } from './lib/dictionaries/registry';
import { installCedict, diacriticPinyin } from './lib/dictionaries/cedict';
import { installJmdictQuick } from './lib/dictionaries/jmdict';
import * as tcloud from './lib/tokori-cloud';
import * as tlocal from './lib/tokori-local';
import {
  addToDay,
  applyBeat,
  finalizeActive,
  pushSession,
  removeSession,
  totals,
  STALE_ACTIVE_MS,
  type ImmersionActive,
  type ImmersionDayMap,
  type ImmersionSessionEntry,
} from './lib/immersion';
import {
  addLocalLibraryItem,
  applyLocalLibraryBeat,
  listLocalLibrary,
  lookupLocalLibrary,
  removeLocalLibraryItem,
} from './lib/local-library';

// ── Cached state ──────────────────────────────────────────────────
//
// The handlers run synchronously per-dispatch and can't afford an
// async storage.get every time. We snapshot the bits they actually
// branch on into module scope and refresh on chrome.storage.onChanged.

let MODE: Mode = DEFAULT_SETTINGS.mode;
let CLOUD_TOKEN: string | null = null;
let CLOUD_API_BASE: string = DEFAULT_SETTINGS.cloudApiBase;
let LOCAL_API_BASE = DEFAULT_SETTINGS.localApi.baseUrl;
let LOCAL_API_TOKEN: string | null = null;
let DESKTOP_ONLINE = false;
let AUTO_DETECT = DEFAULT_SETTINGS.autoDetectDesktop;
let PREFER_DESKTOP_DICT = DEFAULT_SETTINGS.preferDesktopDict;
let LOCAL_WORKSPACE_ID: number | null = null;
let CLOUD_WORKSPACE_ID: number | null = null;
/** Cached known-words map from the paired desktop workspace (or, when
 *  no desktop is paired, the signed-in cloud workspace). The value is
 *  the FSRS-ish status string (`new` | `learning` | `review` |
 *  `mastered`) so content scripts can colour the underline by status,
 *  mirroring the Tokori desktop chat surface. Consumed via the
 *  `getKnownWords` message with stale-while-revalidate semantics: a
 *  snapshot persisted in chrome.storage.local survives worker
 *  idle-unloads (restored in bootCache), reads revalidate lazily via
 *  ensureKnownWords(), and every real change is pushed to open tabs
 *  through the snapshot write itself (storage.onChanged). */
let KNOWN_WORDS: Map<string, string> = new Map();

async function bootCache() {
  const s = await getSettings();
  MODE = s.mode;
  CLOUD_TOKEN = s.cloud.token;
  CLOUD_API_BASE = s.cloudApiBase;
  LOCAL_API_BASE = s.localApi.baseUrl;
  LOCAL_API_TOKEN = s.localApi.token;
  DESKTOP_ONLINE = s.desktopOnline;
  AUTO_DETECT = s.autoDetectDesktop;
  PREFER_DESKTOP_DICT = s.preferDesktopDict;
  LOCAL_WORKSPACE_ID = s.localWorkspaceId;
  CLOUD_WORKSPACE_ID = s.cloudWorkspaceId;
  // Adopt the persisted known-words snapshot (if it still matches the
  // configured backend + workspace) so the first consumer after a
  // worker wake paints instantly; ensureKnownWords() revalidates in
  // the background when the snapshot is stale.
  try {
    const stored = await chrome.storage.local.get(KNOWN_WORDS_SNAPSHOT_KEY);
    const snap = stored[KNOWN_WORDS_SNAPSHOT_KEY] as KnownWordsSnapshot | undefined;
    const matches =
      snap?.v === 1 && Array.isArray(snap.items)
        ? snap.source === 'desktop'
          ? !!s.localApi.token && s.localWorkspaceId === snap.workspaceId
          : !!s.cloud.token && s.cloudWorkspaceId === snap.workspaceId
        : false;
    if (snap && matches && KNOWN_WORDS_AT === 0) {
      KNOWN_WORDS = new Map(snap.items);
      KNOWN_WORDS_AT = snap.at;
      KNOWN_WORDS_SOURCE = snap.source;
      KNOWN_WORDS_PERSISTED = JSON.stringify(snap.items);
    }
  } catch (e) {
    warn('known-words snapshot restore failed:', e);
  }
}
// Handlers that branch on the cached snapshot await this before reading
// it — an MV3 worker woken *by* a message would otherwise dispatch the
// handler before the storage.get above resolves and see null token /
// default mode for the first request after every idle-unload.
const cacheReady = bootCache();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.mode) MODE = changes.mode.newValue === 'cloud' ? 'cloud' : 'local';
  if (changes.cloud) CLOUD_TOKEN = changes.cloud.newValue?.token ?? null;
  if (changes.cloudApiBase)
    CLOUD_API_BASE = changes.cloudApiBase.newValue ?? DEFAULT_SETTINGS.cloudApiBase;
  if (changes.localApi) {
    LOCAL_API_BASE = changes.localApi.newValue?.baseUrl ?? DEFAULT_SETTINGS.localApi.baseUrl;
    LOCAL_API_TOKEN = changes.localApi.newValue?.token ?? null;
  }
  if (changes.desktopOnline) DESKTOP_ONLINE = !!changes.desktopOnline.newValue;
  if (changes.autoDetectDesktop) AUTO_DETECT = !!changes.autoDetectDesktop.newValue;
  if (changes.preferDesktopDict) PREFER_DESKTOP_DICT = !!changes.preferDesktopDict.newValue;
  if (changes.localWorkspaceId) {
    LOCAL_WORKSPACE_ID = (changes.localWorkspaceId.newValue ?? null) as number | null;
    void refreshKnownWords();
  }
  if (changes.cloudWorkspaceId) {
    CLOUD_WORKSPACE_ID = (changes.cloudWorkspaceId.newValue ?? null) as number | null;
    void refreshKnownWords();
  }
});

/** Epoch ms of the last completed known-words load *in this worker's
 *  lifetime*. MV3 tears the worker down after ~30s idle, wiping the
 *  module-scope KNOWN_WORDS — so consumers must never trust the map
 *  blindly; they go through `ensureKnownWords()` which reloads lazily
 *  on the first read after every wake. */
let KNOWN_WORDS_AT = 0;
let knownWordsInflight: Promise<void> | null = null;
/** Which backend the current KNOWN_WORDS came from, plus the last
 *  failure — surfaced through `getKnownWords` so the caption overlay
 *  can show WHY highlighting is empty instead of failing silently. */
let KNOWN_WORDS_SOURCE: 'desktop' | 'cloud' | 'none' = 'none';
let KNOWN_WORDS_ERROR: string | null = null;

/** How long a loaded map stays servable without a revalidation. */
const KNOWN_WORDS_TTL_MS = 120_000;

/** storage.local key holding the last good KNOWN_WORDS load. Two jobs:
 *  (1) worker wakes restore it in bootCache() so captions colour
 *  instantly (stale-while-revalidate) instead of waiting on a network
 *  round trip, and (2) every rewrite fires storage.onChanged in ALL
 *  content scripts — that's the push channel that recolours open tabs
 *  after a refresh or grade, with zero per-tab bookkeeping. */
const KNOWN_WORDS_SNAPSHOT_KEY = 'knownWordsSnapshot';

interface KnownWordsSnapshot {
  v: 1;
  /** Epoch ms of the fetch that produced `items` — drives staleness. */
  at: number;
  source: 'desktop' | 'cloud';
  /** Workspace the items belong to. A mismatch at boot (workspace
   *  switched while the worker was dead) discards the snapshot. */
  workspaceId: number;
  items: [string, string][];
}

/** JSON of the last persisted `items` — identical content is skipped so
 *  the storage push only fires when the map actually changed. */
let KNOWN_WORDS_PERSISTED = '';

/** Persist KNOWN_WORDS to the snapshot (or clear it on sign-out). Safe
 *  to call after every mutation — unchanged content is a no-op. */
function persistKnownWords(): void {
  if (KNOWN_WORDS_SOURCE === 'none') {
    KNOWN_WORDS_PERSISTED = '';
    void chrome.storage.local.remove(KNOWN_WORDS_SNAPSHOT_KEY);
    return;
  }
  const workspaceId = KNOWN_WORDS_SOURCE === 'desktop' ? LOCAL_WORKSPACE_ID : CLOUD_WORKSPACE_ID;
  if (workspaceId == null) return;
  const items = Array.from(KNOWN_WORDS);
  const json = JSON.stringify(items);
  if (json === KNOWN_WORDS_PERSISTED) return;
  KNOWN_WORDS_PERSISTED = json;
  const snap: KnownWordsSnapshot = {
    v: 1,
    at: KNOWN_WORDS_AT,
    source: KNOWN_WORDS_SOURCE,
    workspaceId,
    items,
  };
  void chrome.storage.local.set({ [KNOWN_WORDS_SNAPSHOT_KEY]: snap });
}

/** Adopt a workspace when a token exists but no workspace was ever
 *  picked. The popup's pair flow (and the auth handoff) only store the
 *  token — historically the workspace was only resolved when the user
 *  happened to open Options, so highlighting / status grading silently
 *  dead-ended for everyone else. Takes the first workspace and persists
 *  it so Options reflects the choice. */
async function ensureWorkspaceIds(): Promise<void> {
  if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID == null) {
    try {
      const ws = await tlocal.listWorkspaces(LOCAL_API_BASE, LOCAL_API_TOKEN);
      if (ws.length) {
        LOCAL_WORKSPACE_ID = ws[0].id;
        await patchSettings({ localWorkspaceId: ws[0].id });
      }
    } catch (e) {
      warn('ensureWorkspaceIds (desktop) failed:', e);
    }
  }
  if (CLOUD_TOKEN && CLOUD_WORKSPACE_ID == null) {
    try {
      const ws = await tcloud.listWorkspaces(CLOUD_API_BASE, CLOUD_TOKEN);
      if (ws.length) {
        CLOUD_WORKSPACE_ID = ws[0].id;
        await patchSettings({ cloudWorkspaceId: ws[0].id });
      }
    } catch (e) {
      warn('ensureWorkspaceIds (cloud) failed:', e);
    }
  }
}

/** SRS statuses that render a non-neutral caption colour — the same
 *  set `statusColorFor` (caption-style.ts) paints. `unseen` is omitted
 *  on purpose: it renders identically to an absent word, so it never
 *  needs a slot in KNOWN_WORDS. Keep in sync with caption-style.ts. */
const HIGHLIGHT_STATUSES = ['new', 'learning', 'review', 'mastered'] as const;

async function refreshKnownWords() {
  // A refresh fired right at worker boot (onStartup, desktop-online
  // flip) must not race bootCache() and read null tokens.
  await cacheReady;
  await ensureWorkspaceIds();
  let lastError: string | null = null;
  // Desktop first (fast loopback, no quota), signed-in cloud account as
  // the fallback so cloud-only users get the same caption highlighting
  // and status grading the paired-desktop path drives. Gated on token
  // presence, not the lagging DESKTOP_ONLINE ping — a down loopback
  // refuses instantly and we fall through to cloud.
  if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) {
    try {
      // The desktop caps `/vocab` at 500 rows server-side and returns
      // them newest-first with no offset paging, so a single fetch on a
      // >500-word workspace silently drops the OLDEST rows — which are
      // exactly the earliest-learned, most-mastered everyday words (在,
      // 的, …) that would then render as "unknown" in captions. The
      // `status` filter is applied *before* that cap, so fetch each
      // highlightable status on its own 500-row budget and merge.
      const token = LOCAL_API_TOKEN;
      const workspaceId = LOCAL_WORKSPACE_ID;
      const perStatus = await Promise.all(
        HIGHLIGHT_STATUSES.map((status) =>
          tlocal.listVocab(LOCAL_API_BASE, token, workspaceId, { status, limit: 500 }),
        ),
      );
      const next = new Map<string, string>();
      for (const rows of perStatus) {
        for (const r of rows) {
          if (r.word) next.set(r.word, r.status || 'new');
        }
      }
      KNOWN_WORDS = next;
      KNOWN_WORDS_AT = Date.now();
      KNOWN_WORDS_SOURCE = 'desktop';
      KNOWN_WORDS_ERROR = null;
      persistKnownWords();
      return;
    } catch (e) {
      lastError = `Tokori desktop: ${e instanceof Error ? e.message : String(e)}`;
      warn('refreshKnownWords (desktop) failed:', e);
    }
  }
  if (CLOUD_TOKEN && CLOUD_WORKSPACE_ID != null) {
    try {
      const rows = await tcloud.listVocab(CLOUD_API_BASE, CLOUD_TOKEN, CLOUD_WORKSPACE_ID);
      const next = new Map<string, string>();
      for (const r of rows) {
        if (r.word) next.set(r.word, r.status || 'new');
      }
      KNOWN_WORDS = next;
      KNOWN_WORDS_AT = Date.now();
      KNOWN_WORDS_SOURCE = 'cloud';
      KNOWN_WORDS_ERROR = null;
      persistKnownWords();
      return;
    } catch (e) {
      lastError = `Tokori cloud: ${e instanceof Error ? e.message : String(e)}`;
      warn('refreshKnownWords (cloud) failed:', e);
    }
  }
  // Nothing succeeded. Two very different cases:
  //  - transient outage (desktop quit / cloud down) with data already
  //    loaded → KEEP serving the stale map rather than wiping caption
  //    colours mid-video; `error` says why and the TTL retries.
  //  - genuinely no backend (signed out / never paired) → clear the
  //    map and the persisted snapshot.
  KNOWN_WORDS_ERROR = lastError;
  // Stamp even failures so an unpaired install doesn't retry the whole
  // chain on every single message.
  KNOWN_WORDS_AT = Date.now();
  const hasBackend =
    (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) || (CLOUD_TOKEN && CLOUD_WORKSPACE_ID != null);
  if (hasBackend && KNOWN_WORDS.size) return;
  KNOWN_WORDS = new Map();
  KNOWN_WORDS_SOURCE = 'none';
  persistKnownWords();
}

/** Make sure KNOWN_WORDS reflects a load from this worker lifetime (or
 *  one at most `maxAgeMs` old), deduping concurrent refreshes. Every
 *  handler that reads the map calls this first — without it, the first
 *  `getKnownWords` after an idle-unload would see an empty map and
 *  captions would silently lose their colours. */
async function ensureKnownWords(maxAgeMs = KNOWN_WORDS_TTL_MS): Promise<void> {
  if (Date.now() - KNOWN_WORDS_AT < maxAgeMs) return;
  if (!knownWordsInflight) {
    knownWordsInflight = refreshKnownWords().finally(() => {
      knownWordsInflight = null;
    });
  }
  await knownWordsInflight;
}

/** SWR gate used by the read handlers: block only when the map has
 *  never been filled at all (first run, or the persisted snapshot was
 *  discarded); otherwise answer instantly from what's in memory and,
 *  when that's older than the TTL, kick a background revalidation —
 *  its snapshot push updates consumers the moment fresh data lands. */
async function knownWordsReady(): Promise<void> {
  if (KNOWN_WORDS_AT === 0) return ensureKnownWords();
  if (Date.now() - KNOWN_WORDS_AT >= KNOWN_WORDS_TTL_MS) void ensureKnownWords();
}

/** Where vocab-state operations (status grading, collections) can go
 *  right now. Desktop wins when paired with a workspace picked; the
 *  cloud account is the fallback. `null` → the popup hides those
 *  affordances. Gated on token + workspace, not the lagging online
 *  ping — the loopback either answers instantly or refuses instantly,
 *  and the action handlers fall through to cloud on failure anyway. */
function vocabVia(): 'desktop' | 'cloud' | null {
  if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) return 'desktop';
  if (CLOUD_TOKEN && CLOUD_WORKSPACE_ID != null) return 'cloud';
  return null;
}

/** Word → display reading (diacritic pinyin / kana), null = known miss.
 *  Worker-lifetime cache behind the `dictReadings` batch action. */
const READINGS_CACHE = new Map<string, string | null>();

/** Default Edge TTS voice per target language — the same Microsoft
 *  Neural voices the desktop's TTS defaults use, extended to every
 *  language the extension ships. Cloud `/ai/v1/tts/edge` synthesises;
 *  languages missing here fall back to browser speechSynthesis in the
 *  content script. */
const EDGE_VOICE_BY_LANG: Partial<Record<LanguageCode, string>> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  de: 'de-DE-KatjaNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  ar: 'ar-SA-ZariyahNeural',
  hi: 'hi-IN-SwaraNeural',
  vi: 'vi-VN-HoaiMyNeural',
  th: 'th-TH-PremwadeeNeural',
  id: 'id-ID-GadisNeural',
  tr: 'tr-TR-EmelNeural',
  pl: 'pl-PL-ZofiaNeural',
  nl: 'nl-NL-ColetteNeural',
  sv: 'sv-SE-SofieNeural',
};

// ── Auto-detect: ping the desktop API on an alarm so the popup +
//    content scripts can react to it coming online without each
//    polling on its own.

const DESKTOP_PING_ALARM = 'tokori-desktop-ping';

async function refreshDesktopStatus() {
  if (!AUTO_DETECT) return;
  const ok = await tlocal.ping(LOCAL_API_BASE);
  if (ok !== DESKTOP_ONLINE) {
    DESKTOP_ONLINE = ok;
    await patchSettings({ desktopOnline: ok });
    // Coming online with a token + workspace already configured? Refresh
    // the known-words cache so highlighting kicks in without waiting for
    // the next periodic refresh.
    if (ok) void refreshKnownWords();
  }
}

chrome.alarms.create(DESKTOP_PING_ALARM, { periodInMinutes: 1, when: Date.now() + 2_000 });
// The fixed 5-min known-words alarm is gone: reads revalidate through
// knownWordsReady()/ensureKnownWords() (stale-while-revalidate) and
// changes push via the storage snapshot — so the network is only hit
// while something is actually consuming the map. Clear the alarm any
// older install left registered.
void chrome.alarms.clear('tokori-known-words-refresh');
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DESKTOP_PING_ALARM) void refreshDesktopStatus();
});

// ── Immersion tracking (study mode) ───────────────────────────────
//
// The YT enhancer's ⏱ pill starts/stops a session; while one is
// active the content script posts heartbeat deltas of actually-watched
// time (video playing; wall-clock when the count-while-paused option
// is on). Persistence lives in chrome.storage.local so the stats page
// works fully standalone and survives worker unloads / browser
// restarts. Finished sessions are additionally pushed into the paired
// Tokori desktop's study_sessions table (kind 'immersion') so the
// desktop dashboard's KPIs / heatmap / streak count Companion time —
// best-effort, retried while entries remain unsynced.

const IMMERSION_ACTIVE_KEY = 'immersionActive';
const IMMERSION_DAYS_KEY = 'immersionDays';
const IMMERSION_SESSIONS_KEY = 'immersionSessions';

/** Content beats arrive every ~10s; the desktop's live row only needs
 *  one every ~30s (each UPDATE marks the row dirty for cloud sync).
 *  Accrual-state transitions (pause/resume) bypass the throttle — the
 *  desktop chip should flip within a second, not half a minute. */
const DESKTOP_BEAT_INTERVAL_MS = 30_000;
let lastDesktopBeatAt = 0;

/** Desktop-issued command picked up by a heartbeat response, held for
 *  the next content control poll (which applies the video-level
 *  effect). One-shot + session-scoped: cleared on start and finalize. */
let pendingLiveControl: 'pause' | 'resume' | null = null;
/** True once the paired desktop 404'd the control route (older build)
 *  — stops the ~3 s poll from hammering a route that isn't there.
 *  Reset on session start; the desktop may have been updated since. */
let liveControlUnsupported = false;

/** Forward a live-row heartbeat (+ optional accrual transition) to the
 *  desktop. The response doubles as the desktop's back-channel: a
 *  queued pause/resume is stashed for the next content control poll,
 *  and a sticky `ended` finalizes the session outright — the safety
 *  net for when the fast poll isn't running (no content surface
 *  alive), costing at most one unflushed content beat (~10 s). */
async function pushDesktopBeat(
  sessionId: number,
  ms: number,
  state?: 'playing' | 'paused',
): Promise<void> {
  try {
    await cacheReady;
    if (!LOCAL_API_TOKEN) return;
    const sync = await tlocal.heartbeatSession(
      LOCAL_API_BASE,
      LOCAL_API_TOKEN,
      sessionId,
      Math.round(ms / 1000),
      state,
    );
    if (sync.ended) {
      await finalizeImmersion(Date.now());
      return;
    }
    if (sync.control) pendingLiveControl = sync.control;
  } catch (e) {
    warn('immersion live heartbeat failed:', e);
  }
}

// ── Watch-list progress forwarding ──────────────────────────────────
//
// Immersion beats carry the player's position/duration; the desktop's
// `/v1/media/progress` turns those into per-video progress for items
// on the user's Immersion watch list (soft no-op for everything else).
// Beats accumulate here and flush on the same 30 s cadence as the
// session heartbeat; a video change flushes the old video's tail first
// so its seconds aren't credited to the next one.

interface PendingMediaBeat {
  url: string;
  deltaMs: number;
  positionSec?: number;
  durationSec?: number;
  ended?: boolean;
}
let pendingMediaBeat: PendingMediaBeat | null = null;
let lastMediaFlushAt = 0;

async function flushMediaProgress(force = false): Promise<void> {
  if (!pendingMediaBeat) return;
  const now = Date.now();
  if (!force && now - lastMediaFlushAt < DESKTOP_BEAT_INTERVAL_MS) return;
  // Detach synchronously — a new beat may land while the fetch is in
  // flight and must start a fresh accumulator, not be clobbered.
  const beat = pendingMediaBeat;
  pendingMediaBeat = null;
  lastMediaFlushAt = now;
  try {
    await cacheReady;
    if (LOCAL_API_TOKEN) {
      await tlocal.reportMediaProgress(LOCAL_API_BASE, LOCAL_API_TOKEN, {
        url: beat.url,
        workspaceId: LOCAL_WORKSPACE_ID ?? undefined,
        positionSecs: beat.positionSec,
        durationSecs: beat.durationSec,
        deltaSecs: Math.round(beat.deltaMs / 1000) || undefined,
        ended: beat.ended,
      });
      return;
    }
    // No desktop paired — the in-browser library is the store.
    await applyLocalLibraryBeat(beat.url, {
      deltaMs: beat.deltaMs,
      positionSec: beat.positionSec,
      durationSec: beat.durationSec,
      ended: beat.ended,
    });
  } catch (e) {
    // Soft-fail: the next beat re-reports position (idempotent via
    // furthest-watched semantics); only the delta seconds are lost.
    warn('media progress beat failed:', e);
  }
}

function noteMediaBeat(
  req: { url?: unknown; positionSec?: unknown; durationSec?: unknown; ended?: unknown },
  deltaMs: number,
): void {
  const url = typeof req.url === 'string' && req.url ? req.url : null;
  if (!url) return;
  if (pendingMediaBeat && pendingMediaBeat.url !== url) void flushMediaProgress(true);
  if (!pendingMediaBeat || pendingMediaBeat.url !== url) {
    pendingMediaBeat = { url, deltaMs: 0 };
  }
  pendingMediaBeat.deltaMs += Math.max(0, deltaMs);
  if (typeof req.positionSec === 'number') pendingMediaBeat.positionSec = req.positionSec;
  if (typeof req.durationSec === 'number') pendingMediaBeat.durationSec = req.durationSec;
  if (req.ended === true) pendingMediaBeat.ended = true;
  void flushMediaProgress();
}

async function getImmersionStore(): Promise<{
  active: ImmersionActive | null;
  days: ImmersionDayMap;
  sessions: ImmersionSessionEntry[];
}> {
  const r = await chrome.storage.local.get([
    IMMERSION_ACTIVE_KEY,
    IMMERSION_DAYS_KEY,
    IMMERSION_SESSIONS_KEY,
  ]);
  return {
    active: (r[IMMERSION_ACTIVE_KEY] as ImmersionActive | undefined) || null,
    days: (r[IMMERSION_DAYS_KEY] as ImmersionDayMap | undefined) || {},
    sessions: (r[IMMERSION_SESSIONS_KEY] as ImmersionSessionEntry[] | undefined) || [],
  };
}

/** End the running session at `endedAt`: fold it into the day totals +
 *  session log (unless too short) and close it out on the desktop. */
async function finalizeImmersion(endedAt: number): Promise<ImmersionSessionEntry | null> {
  const { active, days, sessions } = await getImmersionStore();
  // A stale queued command must never leak into the next session.
  pendingLiveControl = null;
  if (!active) return null;
  const entry = finalizeActive(active, endedAt);
  const liveId = active.desktopSessionId ?? null;
  if (entry && liveId != null) {
    // The desktop tracked this live (kind 'video'); finish the row in
    // place with the final numbers + title. Marked synced up front:
    // even when the finish call misses (desktop just quit), the live
    // row already holds the last heartbeat — re-logging through the
    // one-shot fallback would double-count it.
    entry.synced = true;
    void (async () => {
      try {
        await cacheReady;
        if (!LOCAL_API_TOKEN) return;
        await tlocal.finishSession(LOCAL_API_BASE, LOCAL_API_TOKEN, liveId, {
          durationSecs: Math.round(entry.ms / 1000),
          notes: `Companion: ${entry.title || entry.url || 'video'}`,
        });
      } catch (e) {
        warn('immersion live finish failed:', e);
      }
    })();
  }
  if (entry) {
    addToDay(days, entry.end, entry.ms);
    await chrome.storage.local.set({
      [IMMERSION_DAYS_KEY]: days,
      [IMMERSION_SESSIONS_KEY]: pushSession(sessions, entry),
    });
  }
  await chrome.storage.local.remove(IMMERSION_ACTIVE_KEY);
  if (entry && !entry.synced) void syncImmersionSessions();
  return entry;
}

/** Push unsynced finished sessions into the paired desktop. A miss
 *  (desktop closed / pre-sessions-route build) leaves `synced:false`
 *  and the next finalize / stats read retries. */
let immersionSyncInflight = false;
async function syncImmersionSessions(): Promise<void> {
  if (immersionSyncInflight) return;
  immersionSyncInflight = true;
  try {
    await cacheReady;
    if (!LOCAL_API_TOKEN || LOCAL_WORKSPACE_ID == null) return;
    const token = LOCAL_API_TOKEN;
    const workspaceId = LOCAL_WORKSPACE_ID;
    const { sessions } = await getImmersionStore();
    const done = new Set<number>();
    for (const s of sessions) {
      if (s.synced) continue;
      try {
        await tlocal.logSession(LOCAL_API_BASE, token, {
          workspaceId,
          kind: 'video',
          durationSecs: Math.round(s.ms / 1000),
          when: Math.round(s.end / 1000),
          notes: `Companion: ${s.title || s.url || 'video'}`,
        });
        done.add(s.start);
      } catch (e) {
        warn('immersion desktop sync failed:', e);
        break; // unreachable / old build — retry the rest later
      }
    }
    if (done.size) {
      // Re-read before writing — a session may have been finalized
      // while the pushes were in flight.
      const { sessions: latest } = await getImmersionStore();
      await chrome.storage.local.set({
        [IMMERSION_SESSIONS_KEY]: latest.map((s) =>
          done.has(s.start) ? { ...s, synced: true } : s,
        ),
      });
    }
  } finally {
    immersionSyncInflight = false;
  }
}

// Crash recovery: an active session whose heartbeats stopped long ago
// (tab crashed, browser quit) is finalized at its last beat so the
// tracked time isn't lost — and isn't inflated by the dead gap.
void (async () => {
  const { active } = await getImmersionStore();
  if (active && Date.now() - active.lastBeatAt > STALE_ACTIVE_MS) {
    await finalizeImmersion(active.lastBeatAt);
  }
})();

// ── Local OCR (offscreen tesseract host) ──────────────────────────
//
// The local burned-in-subtitle OCR runs tesseract.js in a
// chrome.offscreen document (MV3 service workers can't spawn the Web
// Worker it needs). Created lazily on the first OCR/warmup call and
// left alive — the worker stays warm between samples.

let offscreenReady: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error('This Chrome version has no offscreen API (needs Chrome 109+).');
  }
  // Single-flight: concurrent createDocument calls throw.
  offscreenReady ??= (async () => {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'Runs the local OCR engine (WebAssembly worker) that reads burned-in video subtitles.',
      });
    }
  })().catch((e) => {
    offscreenReady = null; // allow a retry after a failure
    throw e;
  });
  await offscreenReady;
}

/** Round-trip one OCR/warmup request to the offscreen host. */
async function offscreenOcr(msg: {
  type: 'tokori-local-ocr' | 'tokori-local-ocr-warmup';
  dataUrl?: string;
  tessLang: string;
  /** The crop is already binarized by the sender — skip preprocessing. */
  prepared?: boolean;
}): Promise<{ text: string; confidence: number }> {
  await ensureOffscreenDocument();
  const res = (await chrome.runtime.sendMessage(msg)) as
    { success?: boolean; text?: string; confidence?: number; error?: string } | undefined;
  if (!res?.success) {
    throw new Error(res?.error || 'The local OCR engine did not answer.');
  }
  return { text: res.text || '', confidence: res.confidence ?? 0 };
}

// ── Install / boot ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  debug('Companion installed.', details.reason);
  void detectAnki();
  void refreshDesktopStatus();
  if (details.reason === 'install') {
    const { onboardingComplete } = await chrome.storage.local.get('onboardingComplete');
    if (!onboardingComplete) {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
  }
});

chrome.runtime.onStartup?.addListener(() => {
  void refreshDesktopStatus();
});

// Clear per-tab overrides when a tab closes so storage.session doesn't
// keep growing through long-running browser sessions.
chrome.tabs.onRemoved.addListener((tabId) => {
  void setTabOverride(tabId, null);
});

// Warm the known-words cache the moment a YouTube navigation starts —
// by the time the player and the content script are up, the colours
// are already in memory ("pull it before the video starts"). TTL-gated
// through ensureKnownWords, so SPA hops inside YouTube are free.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  const url = changeInfo.url ?? (changeInfo.status === 'loading' ? tab.url : undefined);
  if (!url) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) void ensureKnownWords();
});

// ── External auth: app.tokori.ai posts the bearer token to us once
//    the user finishes the magic-link flow in the sign-in tab.

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (!sender.url) {
    sendResponse({ success: false, error: 'no_origin' });
    return;
  }
  const allowed = [
    'https://app.tokori.ai',
    'https://tokori.ai',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ];
  if (!allowed.some((o) => sender.url!.startsWith(o + '/'))) {
    sendResponse({ success: false, error: 'origin_not_allowed' });
    return;
  }
  if (request?.action === 'tokoriAuthHandoff' && typeof request.token === 'string') {
    (async () => {
      try {
        const account = await tcloud.validateToken(CLOUD_API_BASE, request.token);
        await patchSettings({
          cloud: { token: account.token, email: account.email },
          cloudWorkspaceId: account.defaultWorkspaceId ?? null,
          mode: 'cloud',
        });
        CLOUD_TOKEN = account.token;
        CLOUD_WORKSPACE_ID = account.defaultWorkspaceId ?? null;
        void refreshKnownWords();
        sendResponse({ success: true, email: account.email });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  sendResponse({ success: false, error: 'unknown_action' });
});

// ── Helpers ───────────────────────────────────────────────────────

function cloudOnly(send: (r: unknown) => void): boolean {
  if (!CLOUD_TOKEN) {
    send(CLOUD_ONLY_ERROR);
    return false;
  }
  return true;
}

// ── Router ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
chrome.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
  // ── Settings / mode ──
  if (request.action === 'getSettings') {
    getSettings().then((s) => sendResponse({ success: true, data: s }));
    return true;
  }
  if (request.action === 'patchSettings') {
    patchSettings(request.patch || {})
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }
  if (request.action === 'getMode') {
    sendResponse({ success: true, mode: MODE });
    return false;
  }

  // ── Per-tab override ──
  if (request.action === 'getTabOverride') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'no_tab' });
      return false;
    }
    getTabOverride(tabId).then((override) => sendResponse({ success: true, override }));
    return true;
  }
  if (request.action === 'setTabOverride') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'no_tab' });
      return false;
    }
    setTabOverride(tabId, request.patch).then(() => sendResponse({ success: true }));
    return true;
  }

  // ── Known words (paired desktop or cloud account) ──
  if (request.action === 'getKnownWords') {
    (async () => {
      await cacheReady;
      // Serve whatever we have — this lifetime's load or the restored
      // snapshot — immediately; block only when there's truly nothing.
      await knownWordsReady();
      // `items` is the new shape ({word, status}); `words` is kept for one
      // release so content scripts on the old shape still highlight words
      // even if just in a single colour. `source`/`error` let the caption
      // overlay explain an empty map instead of silently showing nothing.
      const items = Array.from(KNOWN_WORDS, ([word, status]) => ({ word, status }));
      sendResponse({
        success: true,
        items,
        words: items.map((i) => i.word),
        source: KNOWN_WORDS_SOURCE,
        error: KNOWN_WORDS_ERROR,
      });
    })();
    return true;
  }
  if (request.action === 'refreshKnownWords') {
    refreshKnownWords().then(() => sendResponse({ success: true, count: KNOWN_WORDS.size }));
    return true;
  }

  // ── Word segmentation via desktop jieba ──
  // Returns `tokens: null` when the desktop isn't paired so the content
  // script knows to fall back to Intl.Segmenter instead of waiting.
  if (request.action === 'tokenizeRemote') {
    (async () => {
      await cacheReady;
      if (!LOCAL_API_TOKEN || !DESKTOP_ONLINE) {
        sendResponse({ success: true, tokens: null });
        return;
      }
      const lang = request.lang as LanguageCode;
      const text: string = request.text || '';
      try {
        const tokens = await tlocal.tokenize(LOCAL_API_BASE, LOCAL_API_TOKEN, lang, text);
        sendResponse({ success: true, tokens });
      } catch (e) {
        warn('tokenizeRemote failed:', e);
        sendResponse({ success: true, tokens: null });
      }
    })();
    return true;
  }

  // ── Desktop status / pairing ──
  if (request.action === 'desktopStatus') {
    (async () => {
      await cacheReady;
      await refreshDesktopStatus();
      sendResponse({
        success: true,
        online: DESKTOP_ONLINE,
        hasToken: !!LOCAL_API_TOKEN,
        baseUrl: LOCAL_API_BASE,
      });
    })();
    return true;
  }
  if (request.action === 'desktopPair') {
    (async () => {
      const result = await tlocal.requestPairing(LOCAL_API_BASE);
      if (!result) {
        sendResponse({
          success: false,
          error: 'Pairing declined or unsupported on this Tokori build.',
        });
        return;
      }
      await patchSettings({ localApi: { baseUrl: LOCAL_API_BASE, token: result.token } });
      LOCAL_API_TOKEN = result.token;
      // Adopt a workspace + warm the known-words cache right away — the
      // popup pair flow used to store only the token, leaving every
      // vocab surface dead until the user visited Options.
      void refreshKnownWords();
      sendResponse({ success: true, deviceName: result.deviceName });
    })();
    return true;
  }

  // ── Cloud auth-page flow ──
  if (request.action === 'openCloudAuth') {
    (async () => {
      const s = await getSettings();
      const base = s.cloudApiBase || DEFAULT_SETTINGS.cloudApiBase;
      // Map the API host to its companion web-app host.
      let appBase: string;
      if (/api\.tokori\.ai/.test(base)) appBase = 'https://app.tokori.ai';
      else if (/localhost:3001/.test(base) || /127\.0\.0\.1:3001/.test(base)) appBase = base;
      else appBase = base.replace(/\/+$/, '');
      const extId = chrome.runtime.id;
      const url = `${appBase}/login?extension=${encodeURIComponent(extId)}&redirect=${encodeURIComponent('/account/devices')}`;
      chrome.tabs.create({ url });
      sendResponse({ success: true, url });
    })();
    return true;
  }

  // ── Dictionary lookup ──
  //
  // Order: paired desktop (if `preferDesktopDict`) → browser IDB → cloud.
  // The cloud step is reached whenever the previous sources miss *or*
  // throw — the cloud `/v1/dict/search` is public, so trying it costs
  // a request and a user with no dicts installed locally still gets a
  // useful answer instead of a dead-end "Dictionary search failed."
  //
  // Desktop is gated on token presence, not the cached DESKTOP_ONLINE
  // flag — that flag lags by up to a minute so gating on it leaves a
  // freshly-paired user with no lookups until the next ping.
  if (request.action === 'dictLookup') {
    (async () => {
      await cacheReady;
      const lang = (request.lang as LanguageCode) || detectLanguage(request.query || '') || 'zh';
      const query = request.query || '';
      const desktopPaired = !!LOCAL_API_TOKEN && PREFER_DESKTOP_DICT;
      let desktopError: string | null = null;

      if (desktopPaired) {
        try {
          const hits = await tlocal.dictSearch(LOCAL_API_BASE, LOCAL_API_TOKEN!, lang, query);
          if (hits.length) {
            sendResponse({ success: true, data: { entries: hits }, source: 'desktop' });
            return;
          }
        } catch (e) {
          desktopError = e instanceof Error ? e.message : String(e);
          warn('desktop dict lookup failed:', desktopError);
        }
      }

      try {
        const local = await localDictLookup(lang, query);
        if (local.length) {
          sendResponse({ success: true, data: { entries: local }, source: 'local' });
          return;
        }
      } catch (e) {
        warn('local dict lookup threw:', e);
      }

      try {
        const hits = await tcloud.dictSearch(CLOUD_API_BASE, lang, query);
        if (hits.length) {
          sendResponse({ success: true, data: { entries: hits }, source: 'cloud' });
          return;
        }
      } catch (e) {
        warn('cloud dict lookup threw:', e);
      }

      // All sources missed. If the desktop errored, point the user at
      // the dictionaries panel — that's the most common cause (no dict
      // installed for this language yet on the desktop side).
      if (desktopError) {
        sendResponse({
          success: false,
          error: `No match for "${query}". Tokori desktop returned: ${desktopError}. Open Tokori → Settings → Dictionaries and install one for ${lang.toUpperCase()}.`,
          errorCode: 'desktop_dict_failed',
        });
      } else if (desktopPaired) {
        sendResponse({
          success: false,
          error: `No entry for "${query}". Install a dictionary in Tokori → Settings → Dictionaries (or in the extension's Options → Dictionaries).`,
          errorCode: 'desktop_dict_miss',
        });
      } else {
        sendResponse({
          success: false,
          error: `No entry for "${query}".`,
          errorCode: 'dict_miss',
        });
      }
    })();
    return true;
  }

  // ── Batch readings (pinyin / furigana ruby for captions) ──
  //
  // The caption overlay + sidebar ask for the readings of every token
  // in the active cue at once. IDB dictionaries answer instantly and
  // offline; the paired desktop's dict covers what IDB misses. Results
  // (including misses, as null) are cached for the worker's lifetime so
  // a word costs one lookup per session.
  if (request.action === 'dictReadings') {
    (async () => {
      await cacheReady;
      const lang = (request.lang as LanguageCode) || 'zh';
      const words = ((request.words as string[]) || []).slice(0, 120);
      const out: Record<string, string | null> = {};
      for (const w of new Set(words)) {
        if (!w) continue;
        const key = `${lang}:${w}`;
        const cached = READINGS_CACHE.get(key);
        if (cached !== undefined) {
          out[w] = cached;
          continue;
        }
        let reading: string | null = null;
        try {
          const hits = await localDictLookup(lang, w);
          reading =
            (hits.find((e) => e.word === w && e.reading) ?? hits.find((e) => e.reading))?.reading ||
            null;
        } catch {
          /* IDB unavailable — fall through */
        }
        if (reading == null && LOCAL_API_TOKEN) {
          try {
            const hits = await tlocal.dictSearch(LOCAL_API_BASE, LOCAL_API_TOKEN, lang, w);
            reading =
              (hits.find((e) => e.word === w && e.reading) ?? hits.find((e) => e.reading))
                ?.reading || null;
          } catch {
            /* desktop down — miss is cached as null */
          }
        }
        // No entry for the word itself (names, tokenizer compounds):
        // compose the reading character-by-character so pinyin still
        // shows over words no dictionary knows. All-or-nothing — a
        // half-composed reading is worse than none.
        if (reading == null && lang === 'zh') {
          const chars = Array.from(w);
          if (chars.length > 1) {
            const parts: string[] = [];
            for (const ch of chars) {
              try {
                const hits = await localDictLookup(lang, ch);
                const r = hits.find((e) => e.word === ch && e.reading)?.reading;
                if (!r) break;
                parts.push(r);
              } catch {
                break;
              }
            }
            if (parts.length === chars.length) reading = parts.join(' ');
          }
        }
        // Numeric-tone pinyin (Yomitan zh packs) → diacritics for display.
        if (reading && lang === 'zh' && /\d/.test(reading)) reading = diacriticPinyin(reading);
        READINGS_CACHE.set(key, reading);
        out[w] = reading;
      }
      sendResponse({ success: true, readings: out });
    })();
    return true;
  }

  // ── Dictionary management ──
  if (request.action === 'dictListInstalled') {
    listMeta()
      .then((metas) => sendResponse({ success: true, metas }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }
  if (request.action === 'dictDelete') {
    deleteDict(request.dictId)
      .then(() => sendResponse({ success: true }))
      .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  // ── Anki ──
  if (request.action === 'ankiDetect') {
    detectAnki().then((mode) => sendResponse({ success: true, mode }));
    return true;
  }
  if (request.action === 'ankiInvoke') {
    detectAnki()
      .then((mode) => {
        if (!mode)
          throw new Error('AnkiConnect not detected. Open Anki with AnkiConnect installed.');
        return ac(request.method, request.params || {});
      })
      .then((result) => sendResponse({ success: true, result }))
      .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
    return true;
  }
  if (request.action === 'ankiGetDecks') {
    ac<string[]>('deckNames')
      .then((d) => sendResponse({ success: true, decks: (d || []).filter(Boolean).sort() }))
      .catch((e) => sendResponse({ success: false, error: e?.message || 'deck_list_failed' }));
    return true;
  }
  if (request.action === 'ankiGetModels') {
    ac<string[]>('modelNames')
      .then((m) => sendResponse({ success: true, models: (m || []).filter(Boolean).sort() }))
      .catch((e) => sendResponse({ success: false, error: e?.message || 'model_list_failed' }));
    return true;
  }
  if (request.action === 'ankiGetModelFields') {
    if (!request.modelName) {
      sendResponse({ success: false, error: 'modelName_required' });
      return false;
    }
    ac<string[]>('modelFieldNames', { modelName: request.modelName })
      .then((fields) =>
        sendResponse({ success: true, modelName: request.modelName, fields: fields || [] }),
      )
      .catch((e) => sendResponse({ success: false, error: e?.message || 'field_list_failed' }));
    return true;
  }
  if (request.action === 'getAnkiMode') {
    sendResponse({ success: true, mode: getAnkiMode() });
    return false;
  }

  // ── Save vocab (fan out to all enabled targets) ──
  //
  // Accepts the original {word, reading, definition, sentence,
  // translation, sourceUrl} payload from the dict popup, plus the
  // mining extension fields:
  //   • frontExtra — cloze-marked sentence ("I went to the {{c1::store}}")
  //   • cardNotes  — free-form notes
  //   • kind       — 'vocab' | 'sentence' (Tokori desktop record type)
  //   • image      — { dataUrl, mime } screenshot to attach
  //   • clip       — { dataUrl, mime, durationSec } A/V clip to attach
  //
  // Anki: image/clip are uploaded via storeMediaFile and the
  // corresponding markers (image, clip) get `<img>` / `[sound:…]` HTML.
  // Tokori local: media + frontExtra/cardNotes go on the createVocab
  // body — the desktop persists them server-side via updateVocabFields.
  // Tokori cloud: text-only for now; media is dropped with a noted
  // warning so the UI can surface "image not saved to cloud".
  if (request.action === 'saveVocab') {
    (async () => {
      await cacheReady;
      const s = await getSettings();
      const tabId = request.tabId ?? sender.tab?.id;
      const override = typeof tabId === 'number' ? await getTabOverride(tabId) : null;
      const targets = resolveSaveTargets(s.save, override);

      const word = request.word as string;
      const reading = (request.reading || '') as string;
      const definition = (request.definition || '') as string;
      const sentence = (request.sentence || '') as string;
      const translation = (request.translation || '') as string;
      const sourceUrl = (request.sourceUrl || '') as string;
      const frontExtra = (request.frontExtra || '') as string;
      const cardNotes = (request.cardNotes || '') as string;
      const kind = (request.kind || 'vocab') as 'vocab' | 'sentence';
      const lang = (request.lang || 'unknown') as string;
      const image = request.image as { dataUrl: string; mime: string } | undefined;
      const clip = request.clip as
        { dataUrl: string; mime: string; durationSec: number } | undefined;

      const results: Record<
        string,
        { ok: boolean; error?: string; id?: number; warning?: string }
      > = {};

      if (targets.anki) {
        try {
          let imageRef = '';
          let clipRef = '';
          if (image?.dataUrl) {
            const ext = mimeToExt(image.mime, 'jpg');
            const name = makeMediaFilename('img', lang, word, ext);
            const stored = await storeMediaFile(name, image.dataUrl);
            imageRef = `<img src="${stored}">`;
          }
          if (clip?.dataUrl) {
            const ext = mimeToExt(clip.mime, 'webm');
            const name = makeMediaFilename('clip', lang, word, ext);
            const stored = await storeMediaFile(name, clip.dataUrl);
            clipRef = `[sound:${stored}]`;
          }
          // For mined cards we want the sentence field to carry the
          // marked-up form (cloze or <b>) so Anki preserves the
          // emphasis. Falls back to the plain sentence when no
          // frontExtra was supplied (non-mining saves).
          const sentenceForAnki = frontExtra || sentence;
          const fields = buildAnkiFields(s.anki.fieldMap, {
            word,
            reading,
            definition,
            sentence: sentenceForAnki,
            translation,
            sourceUrl,
            image: imageRef,
            clip: clipRef,
          });
          const note: AddNoteInput = {
            deck: s.anki.deck,
            model: s.anki.model,
            fields,
            tags: ['tokori', `tk-${lang}`, ...(kind === 'sentence' ? ['tk-sentence'] : [])],
          };
          const id = await addNote(note);
          results.anki = { ok: true, id };
        } catch (e) {
          results.anki = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (targets.tokoriLocal) {
        try {
          if (!LOCAL_API_TOKEN || !s.localWorkspaceId)
            throw new Error('Set Tokori desktop API token + workspace in Options first.');
          const r = await tlocal.createVocab(LOCAL_API_BASE, LOCAL_API_TOKEN, {
            workspaceId: s.localWorkspaceId,
            word,
            reading,
            definition,
            sentence,
            translation,
            source_url: sourceUrl,
            kind,
            front_extra: frontExtra || undefined,
            card_notes: cardNotes || undefined,
            image_data: image?.dataUrl,
            // The desktop has no clip columns, but it DOES store card
            // audio (bare base64 → BLOB). Bridge the captured clip in as
            // the card's audio so mined cards play sound on the desktop.
            // Sent ONCE — a duplicate `clip_data` copy used to double the
            // multi-MB body and trip the desktop's request-size limit.
            audio_data: clip?.dataUrl ? stripDataUrl(clip.dataUrl) : undefined,
            audio_mime: clip?.mime,
          });
          results.tokoriLocal = { ok: true, id: r.id };
        } catch (e) {
          results.tokoriLocal = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (targets.tokoriCloud) {
        try {
          if (!CLOUD_TOKEN || !s.cloudWorkspaceId)
            throw new Error('Sign in to Tokori cloud + pick a workspace first.');
          const r = await tcloud.createVocab(CLOUD_API_BASE, CLOUD_TOKEN, {
            workspaceId: s.cloudWorkspaceId,
            word,
            reading,
            definition,
            sentence,
            translation,
            sourceUrl,
          });
          // Cloud doesn't yet persist mining media — surface a warning
          // so the modal can tell the user instead of pretending the
          // image/clip went through.
          const droppedMedia = !!(image?.dataUrl || clip?.dataUrl || frontExtra);
          results.tokoriCloud = droppedMedia
            ? {
                ok: true,
                id: r.id,
                warning:
                  'Image / clip / cloze marking dropped — Tokori cloud does not store mining media yet.',
              }
            : { ok: true, id: r.id };
        } catch (e) {
          results.tokoriCloud = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      const enabled = Object.keys(results);
      const allOk = enabled.length > 0 && enabled.every((k) => results[k].ok);
      // A word that just landed in a Tokori workspace starts as `new` —
      // reflect that in the known-words cache immediately so caption
      // highlighting picks it up without waiting for the next refresh.
      if ((results.tokoriLocal?.ok || results.tokoriCloud?.ok) && word && !KNOWN_WORDS.has(word)) {
        KNOWN_WORDS.set(word, 'new');
        persistKnownWords();
      }
      sendResponse({
        success: allOk,
        results,
        error: allOk ? undefined : 'One or more targets failed — see results.',
      });
    })();
    return true;
  }

  // ── Immersion tracking ──
  // Start / heartbeat / stop for the study-mode timer, plus read-only
  // state for the toolbar pill and the stats page. One global session
  // at a time — the timer follows the user, not a tab.
  if (request.action === 'immersionStart') {
    (async () => {
      const now = Date.now();
      const { active } = await getImmersionStore();
      // A live session (recent beats) is simply adopted — e.g. the
      // pill in a second tab. A stale one is finalized first.
      if (active && now - active.lastBeatAt <= STALE_ACTIVE_MS) {
        sendResponse({ success: true, active: true, startedAt: active.startedAt, ms: active.ms });
        return;
      }
      if (active) await finalizeImmersion(active.lastBeatAt);
      const fresh: ImmersionActive = {
        startedAt: now,
        ms: 0,
        lastBeatAt: now,
        title: (request.title as string) || null,
        url: (request.url as string) || null,
        paused: false,
      };
      // Session-scoped control state resets with the session.
      pendingLiveControl = null;
      liveControlUnsupported = false;
      lastDesktopBeatAt = 0;
      await chrome.storage.local.set({ [IMMERSION_ACTIVE_KEY]: fresh });
      sendResponse({ success: true, active: true, startedAt: now, ms: 0 });
      // Mirror the start into the paired desktop as a LIVE 'video'
      // session — Tokori's own session tracking starts with ours.
      // Best-effort: unpaired / offline / pre-live-API desktops fall
      // back to the one-shot log at session end.
      try {
        await cacheReady;
        if (!LOCAL_API_TOKEN || LOCAL_WORKSPACE_ID == null) return;
        const r = await tlocal.startLiveSession(LOCAL_API_BASE, LOCAL_API_TOKEN, {
          workspaceId: LOCAL_WORKSPACE_ID,
          kind: 'video',
        });
        // Attach onto the CURRENT stored state — a heartbeat may have
        // landed while the start call was in flight.
        const { active: cur } = await getImmersionStore();
        if (cur && cur.startedAt === now) {
          await chrome.storage.local.set({
            [IMMERSION_ACTIVE_KEY]: { ...cur, desktopSessionId: r.id },
          });
        }
      } catch (e) {
        warn('immersion live start failed (one-shot fallback stays):', e);
      }
    })();
    return true;
  }
  if (request.action === 'immersionBeat') {
    (async () => {
      const now = Date.now();
      const { active } = await getImmersionStore();
      if (!active) {
        // Session was finalized elsewhere (stop in another tab, crash
        // recovery) — tell the pill to flip off.
        sendResponse({ success: true, active: false });
        return;
      }
      const next = applyBeat(active, Number(request.deltaMs) || 0, now);
      // Freshen the label so the log names the most recent video.
      if (typeof request.title === 'string' && request.title) next.title = request.title;
      if (typeof request.url === 'string' && request.url) next.url = request.url;
      // Accrual-state edge reported by the content ticker (only sent
      // on the beat where it flipped). This is what makes an organic
      // video pause show up as "Paused" on the desktop chip — and an
      // organic play outrank a stale desktop pause (the server cancels
      // the opposing queued command on our transition).
      let transition: 'playing' | 'paused' | undefined;
      if (typeof request.playing === 'boolean') {
        const nowPaused = !request.playing;
        if (nowPaused !== !!next.paused) {
          next.paused = nowPaused;
          transition = nowPaused ? 'paused' : 'playing';
        }
      }
      await chrome.storage.local.set({ [IMMERSION_ACTIVE_KEY]: next });
      sendResponse({
        success: true,
        active: true,
        startedAt: next.startedAt,
        ms: next.ms,
        paused: !!next.paused,
      });
      // Advance the watch-list item this video maps to (if any) —
      // accumulated + throttled, so it shares the session heartbeat's
      // write cadence.
      noteMediaBeat(request, Number(request.deltaMs) || 0);
      // Forward to the desktop's live row, throttled — every content
      // beat (10s) would churn the desktop's cloud-sync dirty flags
      // for no benefit. Transitions skip the throttle so the chip
      // flips promptly. Fire-and-forget; the row self-repairs on the
      // next beat.
      if (
        next.desktopSessionId != null &&
        (transition || now - lastDesktopBeatAt >= DESKTOP_BEAT_INTERVAL_MS)
      ) {
        lastDesktopBeatAt = now;
        await pushDesktopBeat(next.desktopSessionId, next.ms, transition);
      }
    })();
    return true;
  }
  if (request.action === 'immersionStop') {
    (async () => {
      const now = Date.now();
      const { active } = await getImmersionStore();
      if (!active) {
        sendResponse({ success: true, active: false, entry: null });
        return;
      }
      // Credit the final partial beat before closing the session.
      const withTail = applyBeat(active, Number(request.deltaMs) || 0, now);
      await chrome.storage.local.set({ [IMMERSION_ACTIVE_KEY]: withTail });
      // Final watch-list beat — carries the last position + the tail
      // seconds, force-flushed so stopping never strands progress.
      noteMediaBeat(request, Number(request.deltaMs) || 0);
      void flushMediaProgress(true);
      const entry = await finalizeImmersion(now);
      sendResponse({ success: true, active: false, entry });
    })();
    return true;
  }
  if (request.action === 'immersionState') {
    (async () => {
      const now = Date.now();
      const { active, days } = await getImmersionStore();
      const live = active && now - active.lastBeatAt <= STALE_ACTIVE_MS ? active : null;
      sendResponse({
        success: true,
        active: !!live,
        startedAt: live?.startedAt ?? null,
        ms: live?.ms ?? 0,
        paused: !!live?.paused,
        // Running time isn't folded into the day map until stop —
        // include it so "today" reads live.
        todayMs: totals(days, now).todayMs + (live?.ms ?? 0),
      });
    })();
    return true;
  }
  // Fast control channel: content surfaces poll this every ~3 s while
  // a session runs, so a desktop-issued pause/resume/end lands within
  // seconds instead of a heartbeat interval. The background gates the
  // actual HTTP on having a live desktop row and a desktop new enough
  // to expose the route; the video-level effect (pausing the player)
  // happens in the polling content script via the returned `control`.
  if (request.action === 'immersionControlPoll') {
    (async () => {
      const { active } = await getImmersionStore();
      if (!active) {
        sendResponse({ success: true, active: false });
        return;
      }
      // A command may already be waiting, picked up by a 30 s
      // heartbeat's response.
      let control = pendingLiveControl;
      pendingLiveControl = null;
      let ended = false;
      if (!control && active.desktopSessionId != null && !liveControlUnsupported) {
        try {
          await cacheReady;
          if (LOCAL_API_TOKEN) {
            const sync = await tlocal.sessionControl(
              LOCAL_API_BASE,
              LOCAL_API_TOKEN,
              active.desktopSessionId,
            );
            control = sync.control;
            ended = sync.ended;
          }
        } catch (e) {
          if (e instanceof tlocal.LocalApiError && e.status === 404) {
            liveControlUnsupported = true;
          }
          // Transient miss: answer local state; the next poll retries.
        }
      }
      if (ended) {
        // The user ended the session from the desktop. Don't finalize
        // here — the content script answers by sending its unflushed
        // tail through the normal immersionStop path. `ended` is
        // sticky server-side, so a lost response just redelivers.
        sendResponse({
          success: true,
          active: true,
          endRequested: true,
          paused: !!active.paused,
        });
        return;
      }
      if (control) {
        // Session-level effect here; the desktop chip flips only on
        // our confirming transition beat, so send it right away.
        const nowPaused = control === 'pause';
        if (nowPaused !== !!active.paused) {
          const next = { ...active, paused: nowPaused };
          await chrome.storage.local.set({ [IMMERSION_ACTIVE_KEY]: next });
          if (next.desktopSessionId != null) {
            lastDesktopBeatAt = Date.now();
            void pushDesktopBeat(next.desktopSessionId, next.ms, nowPaused ? 'paused' : 'playing');
          }
        }
        sendResponse({ success: true, active: true, control, paused: nowPaused });
        return;
      }
      sendResponse({ success: true, active: true, control: null, paused: !!active.paused });
    })();
    return true;
  }
  if (request.action === 'immersionStats') {
    (async () => {
      const { active, days, sessions } = await getImmersionStore();
      // A stats read is a natural moment to retry pending desktop
      // pushes — the page re-reads on the storage change event.
      void syncImmersionSessions();
      sendResponse({ success: true, active, days, sessions });
    })();
    return true;
  }
  // Delete one logged session (stats page): out of the log, and its
  // time handed back from the day totals. Local store only — a copy
  // already mirrored into the desktop's study_sessions stays there
  // (that log belongs to the desktop; it exposes no delete API).
  if (request.action === 'immersionDeleteSession') {
    (async () => {
      const { days, sessions } = await getImmersionStore();
      const result = removeSession(sessions, days, Number(request.start), Number(request.end));
      if (!result) {
        // Already gone (double-click, second stats tab) — deleting a
        // deleted thing is success from the user's point of view.
        sendResponse({ success: true });
        return;
      }
      await chrome.storage.local.set({
        [IMMERSION_DAYS_KEY]: result.days,
        [IMMERSION_SESSIONS_KEY]: result.sessions,
      });
      sendResponse({ success: true });
    })();
    return true;
  }

  // ── Anki: install Migaku-style preset (deck + model + fieldMap) ──
  if (request.action === 'ankiInstallMigakuPreset') {
    (async () => {
      try {
        const s = await getSettings();
        const result = await installMigakuPreset({ current: s.anki, force: !!request.force });
        sendResponse({ success: true, result });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Send to Tokori: long-form text → reader doc ──
  if (request.action === 'sendReaderDoc') {
    (async () => {
      const s = await getSettings();
      const { title, body, sourceUrl, language } = request as {
        title: string;
        body: string;
        sourceUrl?: string;
        language: LanguageCode;
      };
      if (s.save.tokoriCloud && CLOUD_TOKEN && s.cloudWorkspaceId) {
        try {
          const r = await tcloud.createReaderDoc(CLOUD_API_BASE, CLOUD_TOKEN, {
            workspaceId: s.cloudWorkspaceId,
            title,
            body,
            sourceUrl,
            language,
          });
          sendResponse({ success: true, target: 'cloud', id: r.id });
          return;
        } catch (e) {
          sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      sendResponse({
        success: false,
        error:
          'Send to Tokori reader needs a signed-in cloud account in Settings (local IPC import is not yet supported).',
        errorCode: 'reader_no_target',
      });
    })();
    return true;
  }

  // ── Watch-list probe: "is this URL on the Immersion list?" ──
  // Paired → the desktop's /v1/media/lookup; unpaired → the in-browser
  // library. Same answer shape either way so the content script
  // doesn't care where the list lives.
  if (request.action === 'mediaLookup') {
    (async () => {
      try {
        await cacheReady;
        const url = String(request.url || '');
        if (!url) {
          sendResponse({ success: false, error: 'No URL.' });
          return;
        }
        if (LOCAL_API_TOKEN) {
          const r = await tlocal.lookupMedia(
            LOCAL_API_BASE,
            LOCAL_API_TOKEN,
            url,
            LOCAL_WORKSPACE_ID ?? undefined,
          );
          sendResponse({
            success: true,
            source: 'desktop',
            matched: r.matched,
            item: r.item ?? null,
          });
          return;
        }
        const item = await lookupLocalLibrary(url);
        sendResponse({ success: true, source: 'local', matched: !!item, item });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Library page data: unified list over desktop / in-browser ──
  if (request.action === 'libraryList') {
    (async () => {
      try {
        await cacheReady;
        if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) {
          const items = await tlocal.listMedia(
            LOCAL_API_BASE,
            LOCAL_API_TOKEN,
            LOCAL_WORKSPACE_ID,
            { limit: 200 },
          );
          sendResponse({ success: true, source: 'desktop', items });
          return;
        }
        const items = await listLocalLibrary();
        sendResponse({ success: true, source: 'local', items });
      } catch (e) {
        // Desktop paired but unreachable (app closed) — fall back to
        // the local store rather than a dead page. It may be empty,
        // but the page can say why.
        try {
          const items = await listLocalLibrary();
          sendResponse({
            success: true,
            source: 'local',
            items,
            desktopError: e instanceof Error ? e.message : String(e),
          });
        } catch (e2) {
          sendResponse({ success: false, error: e2 instanceof Error ? e2.message : String(e2) });
        }
      }
    })();
    return true;
  }
  if (request.action === 'libraryRemove') {
    (async () => {
      const removed = await removeLocalLibraryItem(String(request.id || ''));
      sendResponse({ success: true, removed });
    })();
    return true;
  }

  // ── Send to Tokori: YouTube video / generic URL → library item ──
  if (request.action === 'sendLibraryItem') {
    (async () => {
      const s = await getSettings();
      const { kind, title, url, durationSec, source, thumbnailUrl, channel } = request as {
        kind: 'video' | 'article' | 'book' | 'podcast';
        title: string;
        url: string;
        durationSec?: number;
        source?: string;
        thumbnailUrl?: string;
        /** Channel / creator name — becomes the item's author. */
        channel?: string;
      };
      // Watch/listen media prefers the paired desktop's Immersion list
      // (`/v1/media`, desktop ≥ 2026-07) — that's where the progress
      // beats land. Idempotent server-side, so a double-send is safe.
      if (
        (kind === 'video' || kind === 'podcast') &&
        LOCAL_API_TOKEN &&
        s.localWorkspaceId != null
      ) {
        try {
          await cacheReady;
          const item = await tlocal.createMediaItem(LOCAL_API_BASE, LOCAL_API_TOKEN, {
            workspaceId: s.localWorkspaceId,
            title,
            url,
            kind,
            author: channel,
            totalUnits: durationSec ? Math.ceil(durationSec / 60) : undefined,
          });
          sendResponse({ success: true, target: 'desktop', id: item.id });
          return;
        } catch (e) {
          // An older desktop 404s here — fall through to the cloud
          // target rather than dead-ending a paired user.
          warn('local media create failed, trying cloud:', e);
        }
      }
      // No desktop paired — the in-browser library (library.html) is
      // the watch-list store. Cloud stays the fallback for the
      // non-video kinds below only; mixing sources for videos would
      // scatter the list across pages that can't see each other.
      if (kind === 'video' || kind === 'podcast') {
        try {
          const { item, existed } = await addLocalLibraryItem({
            url,
            title,
            channel: channel ?? source ?? null,
            durationSec: durationSec ?? null,
          });
          sendResponse({ success: true, target: 'local', id: item.id, existed });
        } catch (e) {
          sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (s.save.tokoriCloud && CLOUD_TOKEN && s.cloudWorkspaceId) {
        try {
          const r = await tcloud.createLibraryItem(CLOUD_API_BASE, CLOUD_TOKEN, {
            workspaceId: s.cloudWorkspaceId,
            kind,
            title,
            url,
            durationSec,
            source,
            thumbnailUrl,
          });
          sendResponse({ success: true, target: 'cloud', id: r.id });
          return;
        } catch (e) {
          sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      sendResponse({
        success: false,
        error:
          'Send to Tokori needs a paired desktop app (Settings → Desktop) or a signed-in cloud account.',
        errorCode: 'library_no_target',
      });
    })();
    return true;
  }

  // ── Tokori cloud auth ──
  if (request.action === 'cloudSignIn') {
    (async () => {
      try {
        const account = await tcloud.validateToken(CLOUD_API_BASE, request.token);
        await patchSettings({
          cloud: { token: account.token, email: account.email },
          cloudWorkspaceId: account.defaultWorkspaceId ?? null,
        });
        CLOUD_TOKEN = account.token;
        CLOUD_WORKSPACE_ID = account.defaultWorkspaceId ?? null;
        void refreshKnownWords();
        sendResponse({
          success: true,
          email: account.email,
          workspaceId: account.defaultWorkspaceId,
        });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (request.action === 'cloudSignOut') {
    patchSettings({ cloud: { token: null, email: null }, cloudWorkspaceId: null }).then(() => {
      CLOUD_TOKEN = null;
      sendResponse({ success: true });
    });
    return true;
  }
  if (request.action === 'cloudListWorkspaces') {
    if (!cloudOnly(sendResponse)) return false;
    tcloud
      .listWorkspaces(CLOUD_API_BASE, CLOUD_TOKEN!)
      .then((workspaces) => sendResponse({ success: true, workspaces }))
      .catch((e) =>
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }

  // ── Tokori local IPC probe ──
  if (request.action === 'localPing') {
    tlocal.ping(LOCAL_API_BASE).then((ok) => sendResponse({ success: true, ok }));
    return true;
  }
  if (request.action === 'localListWorkspaces') {
    (async () => {
      await cacheReady;
      if (!LOCAL_API_TOKEN) {
        sendResponse({ success: false, error: 'No local API token configured.' });
        return;
      }
      try {
        const workspaces = await tlocal.listWorkspaces(LOCAL_API_BASE, LOCAL_API_TOKEN);
        sendResponse({ success: true, workspaces });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── AI explain (sentence analyzer) ──
  //
  // Order:
  //   1. Bring-your-own provider key (if configured) — called directly,
  //      never proxied through Tokori. A failure here is surfaced rather
  //      than silently fallen back, so a bad key/model stays visible.
  //   2. Desktop AI proxy (if paired + preferDesktopAi).
  //   3. Cloud AI (if signed in).
  //   4. Error — prompt to configure a key, desktop, or cloud.
  if (request.action === 'aiExplain') {
    (async () => {
      await cacheReady;
      const s = await getSettings();
      const lang = (request.lang as LanguageCode) || s.defaultTargetLang;
      const text = request.text || '';

      if (s.ai.provider !== 'none' && s.ai.apiKey) {
        try {
          const r = await explain({
            provider: s.ai.provider,
            apiKey: s.ai.apiKey,
            model: s.ai.model,
            text,
            lang,
          });
          sendResponse({
            success: true,
            data: {
              explanation: r.explanation,
              source: 'byo',
              provider: r.provider,
              model: r.model,
            },
          });
          return;
        } catch (e) {
          sendResponse({
            success: false,
            error: e instanceof Error ? e.message : String(e),
            errorCode: 'ai_byo_failed',
          });
          return;
        }
      }

      if (s.preferDesktopAi && DESKTOP_ONLINE && LOCAL_API_TOKEN) {
        try {
          const r = await tlocal.aiExplain(LOCAL_API_BASE, LOCAL_API_TOKEN, { text, lang });
          sendResponse({
            success: true,
            data: { explanation: r.explanation, source: 'desktop', model: r.model },
          });
          return;
        } catch (e) {
          warn('desktop AI failed, trying cloud:', e);
        }
      }

      if (CLOUD_TOKEN) {
        try {
          const r = await tcloud.aiExplain(CLOUD_API_BASE, CLOUD_TOKEN, { text, lang });
          sendResponse({
            success: true,
            data: { explanation: r.explanation, source: 'cloud', model: r.model },
          });
          return;
        } catch (e) {
          sendResponse({
            success: false,
            error: e instanceof Error ? e.message : String(e),
            errorCode: 'ai_cloud_failed',
          });
          return;
        }
      }

      sendResponse({
        success: false,
        error: 'AI explanations need a paired Tokori desktop app or a signed-in cloud account.',
        errorCode: 'ai_no_provider',
      });
    })();
    return true;
  }

  // ── OCR a video-frame crop (burned-in subtitles) ──
  //
  // Engine per `settings.ocrEngine`:
  //   'auto'  → the local tesseract model when its language pack is
  //             downloaded (Options → AI → Local OCR), else BYO AI.
  //   'local' → local model only — fully offline, no key.
  //   'ai'    → BYO AI vision key only.
  // The content-side sampler already rate-limits and only sends frames
  // whose subtitle region visibly changed.
  if (request.action === 'ocrImage') {
    (async () => {
      const s = await getSettings();
      const lang = (request.lang as LanguageCode) || s.defaultTargetLang;
      const dataUrl = String(request.dataUrl || '');
      const engine = s.ocrEngine || 'auto';
      const tessLang = tesseractLangFor(lang);
      const localReady = !!tessLang && (s.ocrLocalLangs || []).includes(tessLang);

      if (engine === 'local' || (engine === 'auto' && localReady)) {
        try {
          if (!tessLang) {
            throw new Error(`No local OCR model available for "${lang}".`);
          }
          const r = await offscreenOcr({
            type: 'tokori-local-ocr',
            dataUrl,
            tessLang,
            prepared: !!request.prepared,
          });
          sendResponse({ success: true, text: r.text, confidence: r.confidence });
          return;
        } catch (e) {
          if (engine === 'local') {
            sendResponse({
              success: false,
              error: `Local OCR failed: ${e instanceof Error ? e.message : String(e)}`,
            });
            return;
          }
          warn('local OCR failed, falling back to AI:', e);
        }
      }

      if (s.ai.provider === 'none' || !s.ai.apiKey) {
        sendResponse({
          success: false,
          error:
            'OCR needs the local model (Options → AI → Local OCR, one-time download) ' +
            'or an AI key (Options → AI).',
          errorCode: 'ocr_no_provider',
        });
        return;
      }
      const language = getLanguage(lang)?.name ?? lang;
      try {
        const r = await visionOnce({
          provider: s.ai.provider,
          apiKey: s.ai.apiKey,
          model: s.ai.model,
          system:
            'You are an OCR engine for burned-in (hardcoded) video subtitles. ' +
            'Read the subtitle text in the image and reply with ONLY that text — ' +
            'no quotes, no markdown, no commentary. Preserve the original ' +
            'characters exactly; if one subtitle wraps onto two lines, join them ' +
            'with a single space. Ignore watermarks, logos, player UI, and ' +
            'incidental scene text. If no subtitle text is visible, reply with ' +
            'exactly: NONE',
          user:
            `The image is the bottom strip of a video frame. The subtitle is ` +
            `expected to be in ${language} (transcribe whatever it actually says).`,
          imageDataUrl: dataUrl,
        });
        const raw = r.text.trim();
        sendResponse({ success: true, text: /^none[.!]?$/i.test(raw) ? '' : raw });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Local OCR warm-up (fired when OCR mode turns on) ──
  // Spins the offscreen worker + cached model up ahead of the first
  // frame so the first subtitle line doesn't pay the cold start. Only
  // when the pack is already downloaded — a warm-up must never
  // surprise the user with a 15 MB fetch.
  if (request.action === 'ocrLocalWarmup') {
    (async () => {
      try {
        const s = await getSettings();
        const tessLang = tesseractLangFor(String(request.lang || s.defaultTargetLang));
        if (!tessLang || !(s.ocrLocalLangs || []).includes(tessLang)) {
          sendResponse({ success: false, error: 'Local model not downloaded.' });
          return;
        }
        await offscreenOcr({ type: 'tokori-local-ocr-warmup', tessLang });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Local OCR model download (Options → AI → Local OCR) ──
  // Spins the offscreen tesseract worker up for the language, which
  // fetches + caches the pack in IndexedDB; on success the language is
  // recorded in settings so 'auto' starts preferring the local engine.
  if (request.action === 'ocrLocalDownload') {
    (async () => {
      try {
        const tessLang = tesseractLangFor(String(request.lang || ''));
        if (!tessLang) {
          sendResponse({
            success: false,
            error: `No local OCR model is available for "${request.lang}" yet — the AI engine still works for it.`,
          });
          return;
        }
        await offscreenOcr({ type: 'tokori-local-ocr-warmup', tessLang });
        const s = await getSettings();
        const langs = new Set(s.ocrLocalLangs || []);
        langs.add(tessLang);
        await patchSettings({ ocrLocalLangs: [...langs] });
        sendResponse({ success: true, tessLang });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Translate ──
  //
  // Engine per `settings.translateEngine`:
  //   'auto'   → Tokori desktop AI when paired, else keyless Google.
  //   'tokori' → desktop only (error surfaces when unpaired/failing).
  //   'free'   → keyless Google only.
  // The response carries `engine` so the UI can label the result.
  if (request.action === 'translate') {
    (async () => {
      await cacheReady;
      const from = (request.from as LanguageCode) || 'zh';
      const to = (request.to as string) || 'en';
      const text: string = request.text || '';
      const s = await getSettings();
      const engine = s.translateEngine || 'auto';
      if (engine !== 'free' && LOCAL_API_TOKEN && DESKTOP_ONLINE) {
        try {
          const r = await tlocal.translate(LOCAL_API_BASE, LOCAL_API_TOKEN, {
            text,
            source: from,
            target: to,
          });
          sendResponse({ success: true, data: { translation: r.translation, engine: 'tokori' } });
          return;
        } catch (e) {
          warn('desktop translate failed:', e);
          if (engine === 'tokori') {
            sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
            return;
          }
        }
      } else if (engine === 'tokori') {
        sendResponse({
          success: false,
          error: 'Tokori translate needs the paired desktop app running.',
        });
        return;
      }
      try {
        const translation = await freeTranslate(text, from, to);
        sendResponse({ success: true, data: { translation, engine: 'free' } });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Word status (paired desktop or cloud account) ──
  //
  // Upserts the word in the active workspace with the given SRS status
  // and patches the in-memory known-words cache so caption highlighting
  // recolors without waiting for the next refresh alarm. Desktop is
  // tried first; a signed-in cloud account is the fallback, so the
  // popup's status grid works in either connection state.
  if (request.action === 'setWordStatus') {
    (async () => {
      await cacheReady;
      const word = request.word as string;
      const input = {
        word,
        reading: (request.reading || undefined) as string | undefined,
        gloss: (request.gloss || undefined) as string | undefined,
        status: request.status as tlocal.VocabStatus,
      };
      let lastError: unknown = null;
      if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) {
        try {
          const r = await tlocal.setVocabStatus(LOCAL_API_BASE, LOCAL_API_TOKEN, {
            workspaceId: LOCAL_WORKSPACE_ID,
            ...input,
          });
          KNOWN_WORDS.set(word, r.status);
          persistKnownWords();
          sendResponse({ success: true, id: r.id, status: r.status, via: 'desktop' });
          return;
        } catch (e) {
          lastError = e;
          warn('desktop setWordStatus failed:', e);
        }
      }
      if (CLOUD_TOKEN && CLOUD_WORKSPACE_ID != null) {
        try {
          const r = await tcloud.setVocabStatus(CLOUD_API_BASE, CLOUD_TOKEN, {
            workspaceId: CLOUD_WORKSPACE_ID,
            ...input,
          });
          KNOWN_WORDS.set(word, r.status);
          persistKnownWords();
          sendResponse({ success: true, id: r.id, status: r.status, via: 'cloud' });
          return;
        } catch (e) {
          lastError = e;
          warn('cloud setWordStatus failed:', e);
        }
      }
      sendResponse({
        success: false,
        error: lastError
          ? lastError instanceof Error
            ? lastError.message
            : String(lastError)
          : 'Tracking word status needs a paired Tokori desktop app or a signed-in cloud account.',
      });
    })();
    return true;
  }

  // ── Word status lookup (drives the popup's grid + badge) ──
  if (request.action === 'getWordStatus') {
    (async () => {
      await cacheReady;
      await knownWordsReady();
      sendResponse({
        success: true,
        status: KNOWN_WORDS.get(request.word as string) ?? null,
        via: vocabVia(),
      });
    })();
    return true;
  }

  // ── Collections ("+ List" in the word popup) ──
  //
  // `listCollections` resolves desktop-first and reports which backend
  // answered; the add/create calls then pass that `via` back explicitly
  // — collection ids are local to each backend, so silently falling
  // over mid-flow would link words into the wrong database.
  if (request.action === 'listCollections') {
    (async () => {
      await cacheReady;
      let lastError: unknown = null;
      if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) {
        try {
          const collections = await tlocal.listCollections(
            LOCAL_API_BASE,
            LOCAL_API_TOKEN,
            LOCAL_WORKSPACE_ID,
          );
          sendResponse({ success: true, collections, via: 'desktop' });
          return;
        } catch (e) {
          lastError = e;
          warn('desktop listCollections failed:', e);
        }
      }
      if (CLOUD_TOKEN && CLOUD_WORKSPACE_ID != null) {
        try {
          const rows = await tcloud.listCollections(
            CLOUD_API_BASE,
            CLOUD_TOKEN,
            CLOUD_WORKSPACE_ID,
          );
          const collections = rows.map((c) => ({
            id: c.id,
            name: c.name,
            isDefault: c.isDefault,
            wordCount: c.wordCount,
          }));
          sendResponse({ success: true, collections, via: 'cloud' });
          return;
        } catch (e) {
          lastError = e;
          warn('cloud listCollections failed:', e);
        }
      }
      sendResponse({
        success: false,
        error: lastError
          ? lastError instanceof Error
            ? lastError.message
            : String(lastError)
          : 'Collections need a paired Tokori desktop app or a signed-in cloud account.',
      });
    })();
    return true;
  }
  if (request.action === 'addToCollection') {
    (async () => {
      await cacheReady;
      try {
        const via = request.via as 'desktop' | 'cloud';
        const word = request.word as string;
        const reading = (request.reading || undefined) as string | undefined;
        const gloss = (request.gloss || undefined) as string | undefined;
        if (via === 'desktop') {
          if (!LOCAL_API_TOKEN) throw new Error('Tokori desktop is not paired.');
          const r = await tlocal.addWordsToCollection(
            LOCAL_API_BASE,
            LOCAL_API_TOKEN,
            request.collectionId,
            [{ word, reading, gloss }],
          );
          sendResponse({ success: true, existed: r.existed > 0 });
        } else {
          if (!CLOUD_TOKEN || CLOUD_WORKSPACE_ID == null)
            throw new Error('Sign in to Tokori cloud + pick a workspace first.');
          await tcloud.addWordToCollection(CLOUD_API_BASE, CLOUD_TOKEN, {
            workspaceId: CLOUD_WORKSPACE_ID,
            collectionId: request.collectionId,
            word,
            reading,
            gloss,
          });
          sendResponse({ success: true });
        }
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
  if (request.action === 'createCollection') {
    (async () => {
      await cacheReady;
      try {
        const via = request.via as 'desktop' | 'cloud';
        const name = ((request.name as string) || '').trim();
        if (!name) throw new Error('Collection name cannot be empty.');
        if (via === 'desktop') {
          if (!LOCAL_API_TOKEN || LOCAL_WORKSPACE_ID == null)
            throw new Error('Tokori desktop is not paired.');
          const c = await tlocal.createCollection(
            LOCAL_API_BASE,
            LOCAL_API_TOKEN,
            LOCAL_WORKSPACE_ID,
            name,
          );
          sendResponse({ success: true, collection: c });
        } else {
          if (!CLOUD_TOKEN || CLOUD_WORKSPACE_ID == null)
            throw new Error('Sign in to Tokori cloud + pick a workspace first.');
          const c = await tcloud.createCollection(
            CLOUD_API_BASE,
            CLOUD_TOKEN,
            CLOUD_WORKSPACE_ID,
            name,
          );
          sendResponse({
            success: true,
            collection: { id: c.id, name: c.name, isDefault: c.isDefault },
          });
        }
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── TTS ──
  //
  // Synthesises through the cloud's Edge-TTS proxy (auth-optional, so
  // this works signed-out too — anonymous callers just get a stricter
  // rate limit). Any failure answers `audio: null` rather than an
  // error: the content script then falls back to the browser's
  // speechSynthesis, which needs no network at all.
  if (request.action === 'tts') {
    (async () => {
      await cacheReady;
      const text = ((request.text as string) || '').slice(0, 500);
      const lang = request.lang as LanguageCode | undefined;
      const voice = lang ? EDGE_VOICE_BY_LANG[lang] : undefined;
      if (!text || !voice) {
        sendResponse({ success: true, audio: null });
        return;
      }
      try {
        const r = await tcloud.ttsEdge(CLOUD_API_BASE, CLOUD_TOKEN, { text, voice });
        sendResponse({ success: true, audio: r.audio, mime: r.mime });
      } catch (e) {
        warn('cloud tts failed, content will fall back to speechSynthesis:', e);
        sendResponse({ success: true, audio: null });
      }
    })();
    return true;
  }

  // ── AI: generate a dictionary definition ──
  //
  // For words no installed dictionary knows. Same provider order as
  // aiExplain (BYO key surfaces its own failures; desktop proxy; cloud
  // account). A successful generation is persisted into the per-language
  // Personal dict in IndexedDB so the next lookup finds it offline.
  if (request.action === 'aiDefine') {
    (async () => {
      await cacheReady;
      const s = await getSettings();
      const word = ((request.word as string) || '').trim();
      const lang = (request.lang as LanguageCode) || s.defaultTargetLang;
      if (!word) {
        sendResponse({ success: false, error: 'No word given.' });
        return;
      }
      const { system, user } = buildDefinePrompt(word, lang);
      const messages = [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: user },
      ];

      let raw: string | null = null;
      let source: 'byo' | 'desktop' | 'cloud' | null = null;
      let lastError: unknown = null;

      if (s.ai.provider !== 'none' && s.ai.apiKey) {
        // BYO key configured — use it and surface failures instead of
        // silently falling back, so a bad key/model stays visible.
        try {
          raw = (
            await chatOnce({
              provider: s.ai.provider,
              apiKey: s.ai.apiKey,
              model: s.ai.model,
              system,
              user,
            })
          ).text;
          source = 'byo';
        } catch (e) {
          sendResponse({
            success: false,
            error: e instanceof Error ? e.message : String(e),
            errorCode: 'ai_byo_failed',
          });
          return;
        }
      }
      if (raw == null && s.preferDesktopAi && DESKTOP_ONLINE && LOCAL_API_TOKEN) {
        try {
          raw = await tlocal.chatOnce(LOCAL_API_BASE, LOCAL_API_TOKEN, messages);
          source = 'desktop';
        } catch (e) {
          lastError = e;
          warn('desktop aiDefine failed, trying cloud:', e);
        }
      }
      if (raw == null && CLOUD_TOKEN) {
        try {
          raw = await tcloud.chatComplete(CLOUD_API_BASE, CLOUD_TOKEN, messages);
          source = 'cloud';
        } catch (e) {
          lastError = e;
        }
      }
      if (raw == null) {
        sendResponse({
          success: false,
          error: lastError
            ? lastError instanceof Error
              ? lastError.message
              : String(lastError)
            : 'Generating a definition needs an AI key in Options, a paired Tokori desktop app, or a signed-in cloud account.',
          errorCode: 'ai_no_provider',
        });
        return;
      }

      try {
        const def = parseDefineResponse(raw, word);
        const definitions = def.gloss
          .split(/;\s+/)
          .map((x) => x.trim())
          .filter(Boolean);
        const entry: DictEntry = {
          word,
          reading: def.reading || undefined,
          definitions: definitions.length ? definitions : [def.gloss],
        };
        try {
          await upsertPersonalEntry(lang, entry);
        } catch (e) {
          warn('saving generated entry to personal dict failed:', e);
        }
        sendResponse({ success: true, entry, examples: def.examples, source });
      } catch (e) {
        sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  // ── Misc ──
  if (request.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// Make the static install helpers reachable from the options page via
// a runtime port (simpler than awkwardly proxying through messages —
// they run inside the options page directly and just need the
// implementations to be importable). The options page imports the
// implementations directly from `lib/dictionaries/*`.

export { installCedict, installJmdictQuick, packById };
