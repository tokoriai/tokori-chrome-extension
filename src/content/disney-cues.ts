/**
 * Disney+ subtitle capture — MAIN-world script (see manifest), the
 * Disney sibling of netflix-cues.ts. Runs at document_start so the
 * network hooks are in place before the player boots.
 *
 * How it works: Disney+ streams HLS. The master playlist advertises
 * every subtitle rendition as `#EXT-X-MEDIA:TYPE=SUBTITLES` (language,
 * name, media-playlist URI); each media playlist lists small WebVTT
 * segment files. We hook fetch/XHR just to SNIFF master playlists as
 * the player loads them — that yields the track list. When the overlay
 * selects a track we fetch its playlist + segments ourselves (the
 * player only downloads the track it is currently showing, so waiting
 * for its traffic would never produce a second language) and dispatch
 * the merged cue list.
 *
 * Events (same contract as Netflix, 'dp' prefix):
 *   MAIN → content: `tokori-dp-tracks`     {contentId, tracks:[{id,language,label}]}
 *                   `tokori-dp-native-cues`     {cues}
 *                   `tokori-dp-translated-cues` {cues}
 *   content → MAIN: `tokori-dp-request-tracks` (replay after mount)
 *                   `tokori-dp-select` {slot:'native'|'translated', id|null}
 *
 * DRM note: this reads subtitle TEXT only — the A/V stream and its
 * Widevine protection are never touched.
 */

import { parseSubtitles, mergeSegmentCues, type SubtitleCue } from '../lib/subtitles';
import { isMasterWithSubtitles, parseMasterSubtitles, parseMediaSegments } from '../lib/m3u8';

interface DpTrack {
  id: string; // resolved media-playlist URL
  language: string;
  label: string;
}

interface DpManifest {
  contentId: string;
  tracks: DpTrack[];
}

/** Fetching every segment of a feature film is ~a few hundred small
 *  text files; cap defensively against a hostile/looping playlist. */
const MAX_SEGMENTS = 800;
const FETCH_CONCURRENCY = 6;

const manifests = new Map<string, DpManifest>();
let lastManifestId: string | null = null;

/** /play/<guid> (current UI) or /video/<guid> (older links). Falls
 *  back to a constant key — better to serve slightly-stale tracks on
 *  an unknown URL shape than none at all. */
function currentContentId(): string {
  const m = window.location.pathname.match(/\/(?:play|video)\/([\w-]+)/);
  return m?.[1] ?? 'default';
}

function harvestMaster(text: string, url: string): void {
  try {
    const renditions = parseMasterSubtitles(text, url).filter((r) => !r.forced);
    if (renditions.length === 0) return;
    const contentId = currentContentId();
    manifests.set(contentId, {
      contentId,
      tracks: renditions.map((r) => ({ id: r.url, language: r.language, label: r.label })),
    });
    lastManifestId = contentId;
    announceTracks();
  } catch {
    /* never break the player over subtitle plumbing */
  }
}

/** The manifest for what's on screen: exact content-id match first,
 *  else the most recently harvested one (autoplay "next episode"
 *  masters can arrive before the URL flips). */
function currentManifest(): DpManifest | null {
  const cid = currentContentId();
  if (manifests.has(cid)) return manifests.get(cid)!;
  return lastManifestId ? (manifests.get(lastManifestId) ?? null) : null;
}

function announceTracks(): void {
  const man = currentManifest();
  if (!man) return;
  window.dispatchEvent(
    new CustomEvent('tokori-dp-tracks', {
      detail: { contentId: man.contentId, tracks: man.tracks },
    }),
  );
}

// ── Network sniffing: master playlists only ─────────────────────────
//
// Master playlists are small and fetched once per title, so the clone
// cost is negligible; everything else passes through untouched. URL
// shapes vary across their CDNs — sniff by extension OR content-type,
// then verify the body actually is a master with subtitles.

function looksLikePlaylist(url: string, contentType: string | null): boolean {
  return /\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(contentType || '');
}

const origFetch = window.fetch;
window.fetch = async (...args: Parameters<typeof fetch>) => {
  const res = await origFetch(...args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
    if (looksLikePlaylist(url, res.headers.get('content-type'))) {
      void res
        .clone()
        .text()
        .then((body) => {
          if (isMasterWithSubtitles(body)) harvestMaster(body, res.url || url);
        })
        .catch(() => {});
    }
  } catch {
    /* sniffing must never affect the page's own request */
  }
  return res;
};

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
/* eslint-disable @typescript-eslint/no-explicit-any */
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest & { _tkDpUrl?: string },
  method: string,
  url: string | URL,
  ...rest: any[]
) {
  this._tkDpUrl = url?.toString() || '';
  return (origOpen as any).call(this, method, url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

XMLHttpRequest.prototype.send = function (
  this: XMLHttpRequest & { _tkDpUrl?: string },
  ...args: any[]
) {
  const url = this._tkDpUrl || '';
  if (/\.m3u8(\?|#|$)/i.test(url)) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') {
          const body = this.responseText || '';
          if (isMasterWithSubtitles(body)) harvestMaster(body, url);
        }
      } catch {
        /* ignore */
      }
    });
  }
  return (origSend as any).call(this, ...args);
} as typeof XMLHttpRequest.prototype.send;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Selection → fetch track → cue delivery ──────────────────────────

const trackCache = new Map<string, SubtitleCue[]>();
/** Serial number per slot so a slow fetch can't overwrite the cues of
 *  a later selection (user flips tracks faster than the CDN answers). */
const deliverGen: Record<'native' | 'translated', number> = { native: 0, translated: 0 };

async function fetchTrack(playlistUrl: string): Promise<SubtitleCue[]> {
  const cached = trackCache.get(playlistUrl);
  if (cached) return cached;
  const playlist = await (await origFetch(playlistUrl)).text();
  const segments = parseMediaSegments(playlist, playlistUrl).slice(0, MAX_SEGMENTS);
  const lists: SubtitleCue[][] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, segments.length) }, async () => {
      while (i < segments.length) {
        const url = segments[i++]!;
        try {
          const body = await (await origFetch(url)).text();
          lists.push(parseSubtitles(body));
        } catch {
          /* one missing segment loses a few seconds of cues, not the track */
        }
      }
    }),
  );
  const cues = mergeSegmentCues(lists);
  trackCache.set(playlistUrl, cues);
  return cues;
}

async function deliver(slot: 'native' | 'translated', id: string | null): Promise<void> {
  const eventName = slot === 'native' ? 'tokori-dp-native-cues' : 'tokori-dp-translated-cues';
  const gen = ++deliverGen[slot];
  if (!id) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues: [] } }));
    return;
  }
  const track = currentManifest()?.tracks.find((t) => t.id === id);
  if (!track) return;
  try {
    const cues = await fetchTrack(track.id);
    if (gen !== deliverGen[slot]) return; // superseded meanwhile
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues } }));
  } catch {
    if (gen !== deliverGen[slot]) return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues: [] } }));
  }
}

window.addEventListener('tokori-dp-request-tracks', () => announceTracks());
window.addEventListener('tokori-dp-select', (e) => {
  const d = (e as CustomEvent).detail as {
    slot?: 'native' | 'translated';
    id?: string | null;
  };
  if (d?.slot) void deliver(d.slot, d.id ?? null);
});

// SPA navigation between titles — re-announce so the enhancer resets
// onto the new title's tracks.
let lastPath = window.location.pathname;
window.setInterval(() => {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    announceTracks();
  }
}, 1000);
