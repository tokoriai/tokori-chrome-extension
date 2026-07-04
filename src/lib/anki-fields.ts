/**
 * Pure helpers for building Anki note fields and resolving media file
 * extensions. Extracted from the background worker so they can be unit
 * tested without booting the service worker.
 */
import type { AnkiMarker } from './settings';

/** Map a field map ({ Front: 'word', … }) plus marker values into the
 *  concrete { fieldName: value } record Anki expects. Markers without a
 *  value yield an empty string so every field in the note is present. */
export function buildAnkiFields(
  fieldMap: Record<string, AnkiMarker>,
  values: Partial<Record<AnkiMarker, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, marker] of Object.entries(fieldMap)) {
    out[field] = values[marker] || '';
  }
  return out;
}

/** Pull a sensible file extension out of a MIME type — falls back to
 *  `fallback` for unknowns so callers always get a usable filename. */
export function mimeToExt(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback;
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  return fallback;
}
