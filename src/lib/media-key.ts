/**
 * Canonical media keys — the extension twin of the Tokori app's
 * `src/lib/media/url.ts` (and the desktop's Rust `media_url.rs`).
 * Only the YouTube rules matter here (the extension tracks YouTube
 * playback), but the grammar is kept identical so keys minted in the
 * browser store compare equal to keys the desktop derives:
 *
 *   yt:<videoId>       watch / shorts / live / embed / youtu.be
 *   yt:pl:<listId>     playlist page without a specific video
 *   web:<host>/<path>  everything else (lowercased host, www. stripped,
 *                      query + fragment dropped, no trailing slash)
 */

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;

function parseHttpUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
  if (!hasScheme && /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(s)) return null;
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function segs(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean);
}

/** The 11-char (by convention) YouTube video id of a URL, or null. */
export function ytVideoId(raw: string): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = segs(u)[0];
    return id && YT_ID.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = u.searchParams.get('v');
  if (v && YT_ID.test(v)) return v;
  const s = segs(u);
  if ((s[0] === 'shorts' || s[0] === 'live' || s[0] === 'embed') && s[1] && YT_ID.test(s[1])) {
    return s[1];
  }
  return null;
}

/** Canonical identity — equal keys mean "the same content". Null when
 *  the string isn't an http(s) URL. */
export function canonicalMediaKey(raw: string): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const id = ytVideoId(raw);
  if (id) return `yt:${id}`;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtube.com' && segs(u)[0] === 'playlist') {
    const list = u.searchParams.get('list');
    if (list) return `yt:pl:${list}`;
  }
  const genericHost = u.host.toLowerCase().replace(/^www\./, '');
  return `web:${genericHost}${u.pathname.replace(/\/+$/, '')}`;
}

/** Normalized shareable watch URL for a YouTube video id. */
export function ytWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Medium-quality thumbnail for YouTube items; null for anything else. */
export function ytThumbnail(raw: string): string | null {
  const id = ytVideoId(raw);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

/** The item's URL with a resume timestamp, when one makes sense
 *  (>30 s in, YouTube only — other sites ignore unknown params, so we
 *  just don't decorate them). */
export function urlWithResume(raw: string, positionSec: number | null): string {
  const id = ytVideoId(raw);
  if (!id || !positionSec || positionSec < 30) return raw;
  return `${ytWatchUrl(id)}&t=${Math.floor(positionSec)}s`;
}
