/**
 * Minimal HLS playlist parsing — just enough for streaming-site
 * subtitle capture (Disney+). A master playlist advertises subtitle
 * renditions via `#EXT-X-MEDIA:TYPE=SUBTITLES` entries; each URI points
 * at a media playlist whose segments are WebVTT files.
 *
 * Pure string → data, no fetching: the MAIN-world site scripts do the
 * network part (page origin, so the site's own CDN CORS applies) and
 * this stays unit-testable.
 */

export interface SubtitleRendition {
  /** Resolved media-playlist URL — doubles as the track id. */
  url: string;
  /** LANGUAGE attribute as given (e.g. 'zh-Hans', 'en'). */
  language: string;
  /** Human-readable NAME, with " (CC)" appended for SDH renditions
   *  that don't already say so. */
  label: string;
  /** FORCED=YES narrative overlays — callers usually skip these. */
  forced: boolean;
}

/** Quick sniff: is this text an HLS master playlist that advertises
 *  subtitle renditions? Used by response hooks to decide whether a
 *  body is worth parsing at all. */
export function isMasterWithSubtitles(text: string): boolean {
  return text.startsWith('#EXTM3U') && text.includes('TYPE=SUBTITLES');
}

/** Attribute list of one `#EXT-X-...:` tag line → key/value map.
 *  Handles quoted values containing commas (`NAME="English [CC]"`). */
export function parseM3u8Attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out[m[1]!] = m[3] !== undefined ? m[3] : (m[2] ?? '').trim();
  }
  return out;
}

/** All SUBTITLES renditions of a master playlist, URIs resolved
 *  against `baseUrl`. Entries without a URI or LANGUAGE are skipped —
 *  they can't be fetched / classified anyway. */
export function parseMasterSubtitles(text: string, baseUrl: string): SubtitleRendition[] {
  const out: SubtitleRendition[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseM3u8Attrs(line);
    if (attrs['TYPE'] !== 'SUBTITLES') continue;
    const uri = attrs['URI'];
    const language = attrs['LANGUAGE'];
    if (!uri || !language) continue;
    let url: string;
    try {
      url = new URL(uri, baseUrl).toString();
    } catch {
      continue;
    }
    const name = attrs['NAME'] || language;
    const sdh =
      (attrs['CHARACTERISTICS'] || '').includes('public.accessibility') &&
      !/\b(cc|sdh)\b/i.test(name);
    out.push({
      url,
      language,
      label: sdh ? `${name} (CC)` : name,
      forced: attrs['FORCED'] === 'YES',
    });
  }
  return out;
}

/** Segment URIs of a media playlist, resolved against `baseUrl`.
 *  Every non-comment line is a segment reference in HLS. */
export function parseMediaSegments(text: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      out.push(new URL(line, baseUrl).toString());
    } catch {
      /* malformed line — skip */
    }
  }
  return out;
}
