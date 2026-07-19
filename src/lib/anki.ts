/**
 * AnkiConnect bridge. Standard JSON-RPC over loopback (no custom
 * Hanpanda / Tokori addon required) — same protocol Yomitan uses.
 *
 * Detection is cached at module scope so the popup doesn't pay for a
 * fresh HTTP probe on every render. The MV3 service worker re-evaluates
 * the module on cold start, which is fine — the cache invalidates
 * naturally.
 */

const ANKI_URL = 'http://127.0.0.1:8765';

export type AnkiMode = 'ankiconnect' | null;

let _mode: AnkiMode = null;

export async function detectAnki(): Promise<AnkiMode> {
  try {
    const r = await fetch(ANKI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'version', version: 6 }),
      signal: AbortSignal.timeout(1500),
    });
    const d = await r.json();
    _mode = d?.result ? 'ankiconnect' : null;
  } catch {
    _mode = null;
  }
  return _mode;
}

export function getAnkiMode(): AnkiMode {
  return _mode;
}

export async function ac<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const r = await fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });
  const d = await r.json();
  if (d?.error) throw new Error(d.error);
  return d.result as T;
}

export interface AddNoteInput {
  deck: string;
  model: string;
  /** Pre-resolved field map: { Front: 'value', Back: 'value' }. The
   *  caller has already substituted the markers from settings. */
  fields: Record<string, string>;
  tags?: string[];
  /** Optional pictures to attach. AnkiConnect will write each file into
   *  the user's collection.media/ folder and insert `<img>` markup into
   *  the named field if it's empty; we usually pre-embed the `<img>`
   *  ourselves so we only use this for the side-effect (the upload).
   *  In practice we call `storeMediaFile` separately and put the tag
   *  into `fields` ourselves — but keeping the shape here means we
   *  don't have to break the AddNoteInput abstraction. */
  picture?: AnkiMediaAttachment[];
  audio?: AnkiMediaAttachment[];
  video?: AnkiMediaAttachment[];
}

export interface AnkiMediaAttachment {
  filename: string;
  /** Base64-encoded payload (NO `data:…;base64,` prefix). The caller
   *  is responsible for stripping it via `stripDataUrl`. */
  data: string;
  /** Which fields the file should be referenced in *if* the field is
   *  currently empty. We almost always pre-embed the reference tag in
   *  `fields` ourselves so the file just exists on disk and the field
   *  has `<img src="filename.jpg">` / `[sound:clip.webm]` already. */
  fields?: string[];
}

export async function addNote(input: AddNoteInput): Promise<number> {
  const note: Record<string, unknown> = {
    deckName: input.deck,
    modelName: input.model,
    fields: input.fields,
    options: { allowDuplicate: false },
    tags: input.tags || ['tokori'],
  };
  if (input.picture && input.picture.length) note.picture = input.picture;
  if (input.audio && input.audio.length) note.audio = input.audio;
  if (input.video && input.video.length) note.video = input.video;
  return ac<number>('addNote', { note });
}

/** Upload a single base64-encoded asset to Anki's collection.media/
 *  directory. Returns the resolved filename Anki actually used (it can
 *  rename to avoid collisions). Use the returned name when building the
 *  field markup so the reference resolves on the user's machine. */
export async function storeMediaFile(filename: string, dataUrl: string): Promise<string> {
  const base64 = stripDataUrl(dataUrl);
  return ac<string>('storeMediaFile', { filename, data: base64 });
}

/** Strip the leading `data:…;base64,` from a data URL. Returns the raw
 *  base64 payload AnkiConnect (and the Tokori desktop's `audio_data`)
 *  expect. Cuts at the `;base64,` marker, NOT the first comma:
 *  MediaRecorder MIMEs carry codec params ("video/webm;codecs=vp9,opus")
 *  whose comma sits before the payload — first-comma parsing shipped
 *  "opus;base64,…" as the data ("audio_data is not valid base64"). */
export function stripDataUrl(dataUrl: string): string {
  const marker = ';base64,';
  const at = dataUrl.indexOf(marker);
  if (at >= 0) return dataUrl.slice(at + marker.length);
  const ix = dataUrl.indexOf(',');
  return ix >= 0 ? dataUrl.slice(ix + 1) : dataUrl;
}

/** Convenience for building media filenames. Anki's media folder is
 *  flat; collisions are avoided with a unix-ms suffix. We prefix
 *  `tokori-` so the user can identify our files when housekeeping. */
export function makeMediaFilename(
  kind: 'img' | 'clip',
  lang: string,
  word: string,
  ext: string,
): string {
  const safeWord = (word || 'card').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 32) || 'card';
  const ts = Date.now();
  return `tokori-${kind}-${lang}-${safeWord}-${ts}.${ext}`;
}
