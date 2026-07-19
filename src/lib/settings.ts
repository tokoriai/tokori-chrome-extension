/**
 * Settings — single source of truth for the extension's mode + per-mode
 * config. Stored in chrome.storage.local (survives restarts, never
 * synced — API keys would otherwise leak through chrome.sync).
 *
 * Mode reference:
 *   • "local"  — no Tokori account required. Dictionary lookups go
 *                through downloaded dicts (CC-CEDICT, JMdict, Yomitan
 *                imports). AI / translate use the user's own keys.
 *                Saving vocab goes through AnkiConnect OR the local
 *                Tokori IPC bridge on 127.0.0.1:53210 (Tauri build).
 *   • "cloud"  — talks to api.tokori.ai for vocab create, library
 *                item create, reader-doc create, dict lookup. Requires
 *                a signed-in Tokori account.
 *
 * The mode is mirrored at module scope in `background.ts` so the
 * synchronous message handlers can gate cloud-only actions without
 * paying for a storage.get on every dispatch.
 */

import type { LanguageCode } from './languages';

export type Mode = 'local' | 'cloud';

/** What gets sent to "Save" when the user clicks "Add to deck" in the
 *  hover popup. Multiple targets can be enabled at once — e.g. send to
 *  both Anki and Tokori. */
export interface SaveTargets {
  anki: boolean;
  /** Tokori desktop via 127.0.0.1:53210. Requires the local API token
   *  copied from the desktop app's Settings → Local API panel. */
  tokoriLocal: boolean;
  /** Tokori cloud via api.tokori.ai. Requires a signed-in account. */
  tokoriCloud: boolean;
}

export interface CloudAuth {
  /** Bearer token issued by api.tokori.ai on sign-in. */
  token: string | null;
  /** Email shown in the popup once signed in. */
  email: string | null;
}

export interface LocalApiConfig {
  /** Base URL of the desktop IPC bridge. Defaults to the address the
   *  Tokori desktop app binds its local API to (127.0.0.1:53210). */
  baseUrl: string;
  /** Bearer token shown in the Tokori desktop app's settings. */
  token: string | null;
}

export interface AnkiConfig {
  /** Deck name to drop new cards into. */
  deck: string;
  /** Note type / model name (must exist in Anki). */
  model: string;
  /** Field map: { Front: 'word', Back: 'definition', … }. Field names
   *  are user-specific (per the chosen model); markers are a fixed set
   *  the extension knows how to populate. */
  fieldMap: Record<string, AnkiMarker>;
}

export type AnkiMarker =
  | 'word' // headword / surface form
  | 'reading' // pinyin / kana / IPA
  | 'definition' // gloss(es) joined with " / "
  | 'sentence' // source sentence (if any) — cloze-marked when mined
  | 'translation' // sentence translation
  | 'audio' // TTS audio (skipped in v0.1)
  | 'image' // screenshot frame from the source (mining)
  | 'clip' // short A/V clip from the source (mining) — Anki [sound:…] tag
  | 'sourceUrl'; // tab URL the card was mined from

/** Which AI provider to call with the user's own key, or 'none' to use
 *  the desktop/cloud fallback chain instead. */
export type AiProvider = 'none' | 'openai' | 'anthropic' | 'gemini';

export interface AiConfig {
  /** Selected provider. 'none' (default) → bring-your-own AI is off. */
  provider: AiProvider;
  /** The user's API key for `provider`. Stored only in
   *  chrome.storage.local (never synced) and sent straight to the
   *  provider — never proxied through Tokori. */
  apiKey: string | null;
  /** Model id. Empty string → the options UI's per-provider default. */
  model: string;
}

export interface Settings {
  /** Overall mode. Default 'local' — the extension works without an
   *  account and the user has to deliberately sign in. */
  mode: Mode;
  /** Where "Add card" goes. */
  save: SaveTargets;
  /** Override for the cloud API base URL. Default is production
   *  (`https://api.tokori.ai`); set to e.g. `http://localhost:3001`
   *  when developing against a local tokori-cloud server. */
  cloudApiBase: string;
  /** Tokori cloud auth state. */
  cloud: CloudAuth;
  /** Tokori local IPC config. */
  localApi: LocalApiConfig;
  /** Anki configuration. */
  anki: AnkiConfig;
  /** User's default target language. Used when we can't detect from
   *  text — also drives the popup's "current workspace" hint. */
  defaultTargetLang: LanguageCode;
  /** Workspace id to attach cloud writes to. Resolved during the
   *  Tokori sign-in flow; falls back to the user's first workspace. */
  cloudWorkspaceId: number | null;
  /** Same idea for local: which Tokori workspace the desktop bridge
   *  should write to. The user picks this in Options after entering
   *  the local API token. */
  localWorkspaceId: number | null;
  /** Hover popup style: card-click to show, or hover-show. */
  triggerMode: 'click' | 'hover';
  /** Auto-detect the Tokori desktop app on a periodic ping. When true,
   *  the background worker probes the local API on boot + every minute
   *  and surfaces a "pair" prompt as soon as the desktop comes online. */
  autoDetectDesktop: boolean;
  /** Last-known reachability of the desktop API (background-maintained). */
  desktopOnline: boolean;
  /** Bring-your-own AI provider config. When `provider` is not 'none'
   *  and a key is set, sentence explanations call the provider directly
   *  from the background worker, ahead of the desktop/cloud fallbacks. */
  ai: AiConfig;
  /** Prefer the desktop's AI proxy when no BYO key is configured. The
   *  fallback chain for explanations is then desktop → cloud; if neither
   *  is reachable, AI features are disabled. */
  preferDesktopAi: boolean;
  /** Prefer the desktop's dictionary lookups (after local IDB) over
   *  the cloud endpoint. */
  preferDesktopDict: boolean;
  /** Translation engine for sentence/word translations:
   *   • 'auto'   — Tokori desktop AI when paired, else the keyless
   *                Google endpoint (default).
   *   • 'tokori' — Tokori desktop AI only; error when not paired.
   *   • 'free'   — keyless Google endpoint only. */
  translateEngine: 'auto' | 'tokori' | 'free';
  /** Sentence-mining configuration. Controls what the YT (and future
   *  Netflix) miner captures by default, and how the studied word is
   *  marked inside the saved sentence. */
  mining: MiningConfig;
  /** Immersion-time tracking (study mode) configuration. */
  immersion: ImmersionConfig;
  /** Engine for the burned-in-subtitle OCR (YouTube):
   *   • 'auto'  — local model when downloaded for the language, else
   *               the BYO AI key (default).
   *   • 'local' — downloaded tesseract model only (fully offline
   *               after the one-time language download).
   *   • 'ai'    — BYO AI vision key only. */
  ocrEngine: 'auto' | 'local' | 'ai';
  /** Tesseract language packs the user downloaded via Options (their
   *  tesseract ids, e.g. 'chi_sim'). The packs themselves live in the
   *  offscreen document's IndexedDB cache. */
  ocrLocalLangs: string[];
}

export interface ImmersionConfig {
  /** Keep the immersion timer accruing while the video is paused.
   *  Default false — pausing the video pauses the timer, so only real
   *  watch time counts. Turn on for e.g. pause-and-shadow routines
   *  where thinking time should still count as study time. */
  countWhilePaused: boolean;
  /** Auto-start the immersion timer when the playing video is on the
   *  watch library. Default true — adding a video to the list is the
   *  opt-in; the timer (and with it, watch-progress tracking) then
   *  takes care of itself. Stopping the timer manually suppresses the
   *  auto-start for that video until you navigate away. */
  autoStartListed: boolean;
}

export interface MiningConfig {
  /** Capture a screenshot of the source video frame at the cue's start
   *  time. Off → mined cards only carry text. */
  screenshotEnabled: boolean;
  /** Longest edge of the captured JPEG. Smaller = faster save + cheaper
   *  storage; 640 fits comfortably under Anki's recommended media size
   *  and the desktop's `image_data` 1500 KB cap. */
  screenshotMaxWidth: number;
  /** JPEG quality 0–1. */
  screenshotQuality: number;
  /** Record a short A/V clip via MediaRecorder. Adds Anki [sound:…] tag
   *  and a WebM blob to the Tokori desktop record. */
  clipEnabled: boolean;
  /** Default clip length in seconds (the modal lets the user override
   *  per-card via a slider). Capped at 8s by the capture helper. */
  clipDurationSec: number;
  /** Cap on clip resolution so a 4K source doesn't produce a 30 MB
   *  WebM. The capture helper downscales below this. */
  clipMaxHeight: number;
  /** Default card shape used when the mining modal opens. The user can
   *  flip it per-card; the choice is also persisted here. */
  defaultCardShape: 'vocab' | 'sentence';
  /** How the studied word is marked inside the saved sentence:
   *   • 'cloze' → `I went to the {{c1::store}}` (Tokori desktop +
   *               Anki Cloze note types render this natively)
   *   • 'bold'  → `I went to the <b>store</b>` (works in any Anki note
   *               type but loses semantic meaning for the desktop) */
  clozeMarker: 'cloze' | 'bold';
}

/** Per-tab save-target override. Stored in chrome.storage.session
 *  (cleared on browser restart) so the "use only Anki for this tab"
 *  choice doesn't leak into other tabs or persist across sessions. */
export interface TabOverride {
  /** null entries mean "use the global default". */
  anki: boolean | null;
  tokoriLocal: boolean | null;
  tokoriCloud: boolean | null;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'local',
  save: { anki: true, tokoriLocal: false, tokoriCloud: false },
  cloudApiBase: 'https://api.tokori.ai',
  cloud: { token: null, email: null },
  localApi: { baseUrl: 'http://127.0.0.1:53210', token: null },
  anki: {
    deck: 'Default',
    model: 'Basic',
    fieldMap: { Front: 'word', Back: 'definition' },
  },
  defaultTargetLang: 'zh',
  cloudWorkspaceId: null,
  localWorkspaceId: null,
  triggerMode: 'click',
  autoDetectDesktop: true,
  desktopOnline: false,
  ai: { provider: 'none', apiKey: null, model: '' },
  preferDesktopAi: true,
  preferDesktopDict: true,
  translateEngine: 'auto',
  mining: {
    screenshotEnabled: true,
    screenshotMaxWidth: 640,
    screenshotQuality: 0.8,
    clipEnabled: true,
    clipDurationSec: 4,
    clipMaxHeight: 480,
    defaultCardShape: 'vocab',
    clozeMarker: 'cloze',
  },
  immersion: {
    countWhilePaused: false,
    autoStartListed: true,
  },
  ocrEngine: 'auto',
  ocrLocalLangs: [],
};

export async function getTabOverride(tabId: number): Promise<TabOverride | null> {
  try {
    const all = await chrome.storage.session.get('tabOverrides');
    const map = (all.tabOverrides || {}) as Record<string, TabOverride>;
    return map[String(tabId)] || null;
  } catch {
    return null;
  }
}

export async function setTabOverride(
  tabId: number,
  patch: Partial<TabOverride> | null,
): Promise<void> {
  try {
    const all = await chrome.storage.session.get('tabOverrides');
    const map = (all.tabOverrides || {}) as Record<string, TabOverride>;
    if (patch === null) {
      delete map[String(tabId)];
    } else {
      const prev = map[String(tabId)] || { anki: null, tokoriLocal: null, tokoriCloud: null };
      map[String(tabId)] = { ...prev, ...patch };
    }
    await chrome.storage.session.set({ tabOverrides: map });
  } catch {}
}

/** Resolve final save targets: per-tab override fields fall back to
 *  the global settings.save when null. */
export function resolveSaveTargets(global: SaveTargets, override: TabOverride | null): SaveTargets {
  if (!override) return global;
  return {
    anki: override.anki ?? global.anki,
    tokoriLocal: override.tokoriLocal ?? global.tokoriLocal,
    tokoriCloud: override.tokoriCloud ?? global.tokoriCloud,
  };
}

/** Production cloud API origin. The user can override per-install via
 *  the `cloudApiBase` setting (e.g. `http://localhost:3001` for local
 *  tokori-cloud dev). Code reads the resolved value from `getSettings()`,
 *  not from this constant. */
export const TOKORI_CLOUD_BASE_DEFAULT = 'https://api.tokori.ai';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(null)) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    save: { ...DEFAULT_SETTINGS.save, ...(stored.save || {}) },
    cloud: { ...DEFAULT_SETTINGS.cloud, ...(stored.cloud || {}) },
    localApi: { ...DEFAULT_SETTINGS.localApi, ...(stored.localApi || {}) },
    anki: { ...DEFAULT_SETTINGS.anki, ...(stored.anki || {}) },
    mining: { ...DEFAULT_SETTINGS.mining, ...(stored.mining || {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai || {}) },
    immersion: { ...DEFAULT_SETTINGS.immersion, ...(stored.immersion || {}) },
  };
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export const CLOUD_ONLY_ERROR = {
  success: false as const,
  error:
    'This feature requires a Tokori cloud account. Sign in from the popup, or switch save target to Anki / Tokori desktop.',
  errorCode: 'cloud_only',
};
