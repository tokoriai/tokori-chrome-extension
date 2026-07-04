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
  buildDefinePrompt,
  parseDefineResponse,
} from './lib/ai-providers';
import { debug, warn } from './lib/log';
import { detectLanguage, type LanguageCode } from './lib/languages';
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
 *  mirroring the Tokori desktop chat surface. Refreshed every few
 *  minutes by an alarm. Consumed via the `getKnownWords` message. */
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

async function refreshKnownWords() {
  await ensureWorkspaceIds();
  let lastError: string | null = null;
  // Desktop first (fast loopback, no quota), signed-in cloud account as
  // the fallback so cloud-only users get the same caption highlighting
  // and status grading the paired-desktop path drives. Gated on token
  // presence, not the lagging DESKTOP_ONLINE ping — a down loopback
  // refuses instantly and we fall through to cloud.
  if (LOCAL_API_TOKEN && LOCAL_WORKSPACE_ID != null) {
    try {
      const rows = await tlocal.listVocab(LOCAL_API_BASE, LOCAL_API_TOKEN, LOCAL_WORKSPACE_ID, {
        limit: 500,
      });
      const next = new Map<string, string>();
      for (const r of rows) {
        if (r.word) next.set(r.word, r.status || 'new');
      }
      KNOWN_WORDS = next;
      KNOWN_WORDS_AT = Date.now();
      KNOWN_WORDS_SOURCE = 'desktop';
      KNOWN_WORDS_ERROR = null;
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
      return;
    } catch (e) {
      lastError = `Tokori cloud: ${e instanceof Error ? e.message : String(e)}`;
      warn('refreshKnownWords (cloud) failed:', e);
    }
  }
  KNOWN_WORDS = new Map();
  KNOWN_WORDS_SOURCE = 'none';
  KNOWN_WORDS_ERROR = lastError;
  // Stamp even the "no connection" outcome so an unpaired install
  // doesn't retry the whole chain on every single message.
  KNOWN_WORDS_AT = Date.now();
}

/** Make sure KNOWN_WORDS reflects a load from this worker lifetime (or
 *  one at most `maxAgeMs` old), deduping concurrent refreshes. Every
 *  handler that reads the map calls this first — without it, the first
 *  `getKnownWords` after an idle-unload would see an empty map and
 *  captions would silently lose their colours. */
async function ensureKnownWords(maxAgeMs = 120_000): Promise<void> {
  if (Date.now() - KNOWN_WORDS_AT < maxAgeMs) return;
  if (!knownWordsInflight) {
    knownWordsInflight = refreshKnownWords().finally(() => {
      knownWordsInflight = null;
    });
  }
  await knownWordsInflight;
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

const KNOWN_WORDS_ALARM = 'tokori-known-words-refresh';
chrome.alarms.create(DESKTOP_PING_ALARM, { periodInMinutes: 1, when: Date.now() + 2_000 });
chrome.alarms.create(KNOWN_WORDS_ALARM, { periodInMinutes: 5, when: Date.now() + 5_000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DESKTOP_PING_ALARM) void refreshDesktopStatus();
  if (alarm.name === KNOWN_WORDS_ALARM) void refreshKnownWords();
});

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

/** `data:video/webm;base64,AAAA…` → `AAAA…`. The desktop's
 *  `audio_data` column takes bare base64 (decoded server-side into a
 *  BLOB), unlike `image_data` which stores the data URL verbatim. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

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
      // Reload lazily — the worker may have just been woken by this very
      // message with an empty module-scope cache.
      await ensureKnownWords();
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
            // Current desktop builds have no clip columns yet, but they DO
            // store card audio (bare base64 → BLOB). Bridge the captured
            // clip in as the card's audio so mined cards play sound on the
            // desktop today; `clip_data` stays on the payload for builds
            // that grow real clip support.
            audio_data: clip?.dataUrl ? stripDataUrlPrefix(clip.dataUrl) : undefined,
            audio_mime: clip?.mime,
            clip_data: clip?.dataUrl,
            clip_mime: clip?.mime,
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
      }
      sendResponse({
        success: allOk,
        results,
        error: allOk ? undefined : 'One or more targets failed — see results.',
      });
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

  // ── Send to Tokori: YouTube video / generic URL → library item ──
  if (request.action === 'sendLibraryItem') {
    (async () => {
      const s = await getSettings();
      const { kind, title, url, durationSec, source, thumbnailUrl } = request as {
        kind: 'video' | 'article' | 'book' | 'podcast';
        title: string;
        url: string;
        durationSec?: number;
        source?: string;
        thumbnailUrl?: string;
      };
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
          'Send to Tokori library needs a signed-in cloud account in Settings (local IPC import is not yet supported).',
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
      await ensureKnownWords();
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
