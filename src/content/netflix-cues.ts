/**
 * Netflix subtitle capture — MAIN-world script (see manifest), the
 * Netflix sibling of youtube-cues.ts. Runs at document_start so the
 * JSON hooks are in place before Netflix's player boots.
 *
 * How it works (the approach Subadub/NflxMultiSubs proved over years):
 *   1. Netflix's player asks its API for a playback manifest listing
 *      `timedtexttracks`. By default the browser profile list yields
 *      image/dfxp subtitle formats — so we hook `JSON.stringify` and
 *      append the `webvtt-lssdh-ios8` profile to any manifest request,
 *      making Netflix include plain-text WebVTT download URLs.
 *   2. We hook `JSON.parse` and grab every parsed object that looks
 *      like a manifest (movieId + timedtexttracks), harvesting each
 *      track's WebVTT URL.
 *   3. The ISOLATED-world enhancer asks for tracks / selects them via
 *      window CustomEvents; we fetch + parse the VTT here (page
 *      origin, so Netflix's CDN CORS applies to the page as normal)
 *      and dispatch cues back.
 *
 * Events (mirroring the YouTube contract):
 *   MAIN → content: `tokori-nf-tracks`     {movieId, tracks:[{id,language,label}]}
 *                   `tokori-nf-native-cues`     {cues}
 *                   `tokori-nf-translated-cues` {cues}
 *   content → MAIN: `tokori-nf-request-tracks` (replay after mount)
 *                   `tokori-nf-select` {slot:'native'|'translated', id|null}
 *
 * DRM note: this reads subtitle TEXT only — video frames stay
 * protected; nothing here touches the stream.
 */

import { parseSubtitles } from '../lib/subtitles';

const WEBVTT_PROFILE = 'webvtt-lssdh-ios8';

interface NfTrack {
  id: string;
  language: string;
  label: string;
  url: string;
}

interface NfManifest {
  movieId: string;
  tracks: NfTrack[];
}

const manifests = new Map<string, NfManifest>();
let lastManifestId: string | null = null;

// ── 1. Request hook: ask for WebVTT ─────────────────────────────────
const origStringify = JSON.stringify.bind(JSON);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(JSON as any).stringify = function (value: unknown, ...rest: unknown[]) {
  try {
    const v = value as { params?: { profiles?: unknown } } | null;
    const profiles = v?.params?.profiles;
    if (
      Array.isArray(profiles) &&
      profiles.some((p) => typeof p === 'string') &&
      !profiles.includes(WEBVTT_PROFILE)
    ) {
      profiles.push(WEBVTT_PROFILE);
    }
  } catch {
    // Never break Netflix over subtitle plumbing.
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origStringify as any)(value, ...rest);
};

// ── 2. Response hook: harvest manifests ─────────────────────────────
const origParse = JSON.parse.bind(JSON);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(JSON as any).parse = function (...args: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (origParse as any)(...args);
  try {
    const result = (parsed as { result?: unknown })?.result;
    const candidates = Array.isArray(result) ? result : [result];
    for (const r of candidates) harvestManifest(r);
  } catch {
    /* not a manifest — fine */
  }
  return parsed;
};

function harvestManifest(m: unknown): void {
  const man = m as {
    movieId?: unknown;
    timedtexttracks?: unknown;
  } | null;
  if (!man || man.movieId == null || !Array.isArray(man.timedtexttracks)) return;
  const movieId = String(man.movieId);
  const tracks: NfTrack[] = [];
  for (const t of man.timedtexttracks as Array<{
    isNoneTrack?: boolean;
    isForcedNarrative?: boolean;
    language?: string;
    languageDescription?: string;
    trackType?: string;
    new_track_id?: string;
    ttDownloadables?: Record<
      string,
      { downloadUrls?: Record<string, string>; urls?: Array<{ url?: string }> }
    >;
  }>) {
    if (t.isNoneTrack || t.isForcedNarrative) continue;
    const dl = t.ttDownloadables?.[WEBVTT_PROFILE];
    if (!dl) continue;
    const url =
      (dl.downloadUrls && Object.values(dl.downloadUrls)[0]) ||
      (Array.isArray(dl.urls) ? dl.urls[0]?.url : undefined);
    if (!url || !t.language) continue;
    tracks.push({
      id: t.new_track_id || `${t.language}:${tracks.length}`,
      language: t.language,
      label:
        (t.languageDescription || t.language) + (t.trackType === 'CLOSEDCAPTIONS' ? ' (CC)' : ''),
      url,
    });
  }
  if (tracks.length === 0) return;
  manifests.set(movieId, { movieId, tracks });
  lastManifestId = movieId;
  announceTracks();
}

/** The manifest for what's actually on screen: match the /watch/<id>
 *  URL when possible, else the most recently harvested one (prefetch
 *  manifests for "next episode" arrive early; the URL match keeps the
 *  current episode's tracks winning once playback starts). */
function currentManifest(): NfManifest | null {
  const m = window.location.pathname.match(/\/watch\/(\d+)/);
  if (m && manifests.has(m[1]!)) return manifests.get(m[1]!)!;
  return lastManifestId ? (manifests.get(lastManifestId) ?? null) : null;
}

function announceTracks(): void {
  const man = currentManifest();
  if (!man) return;
  window.dispatchEvent(
    new CustomEvent('tokori-nf-tracks', {
      detail: {
        movieId: man.movieId,
        tracks: man.tracks.map(({ id, language, label }) => ({ id, language, label })),
      },
    }),
  );
}

// ── 3. Selection + cue delivery ─────────────────────────────────────
const vttCache = new Map<string, ReturnType<typeof parseSubtitles>>();

async function deliver(slot: 'native' | 'translated', id: string | null): Promise<void> {
  const eventName = slot === 'native' ? 'tokori-nf-native-cues' : 'tokori-nf-translated-cues';
  if (!id) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues: [] } }));
    return;
  }
  const track = currentManifest()?.tracks.find((t) => t.id === id);
  if (!track) return;
  try {
    let cues = vttCache.get(track.url);
    if (!cues) {
      const res = await fetch(track.url);
      cues = parseSubtitles(await res.text());
      vttCache.set(track.url, cues);
    }
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues } }));
  } catch {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { cues: [] } }));
  }
}

window.addEventListener('tokori-nf-request-tracks', () => announceTracks());
window.addEventListener('tokori-nf-select', (e) => {
  const d = (e as CustomEvent).detail as {
    slot?: 'native' | 'translated';
    id?: string | null;
  };
  if (d?.slot) void deliver(d.slot, d.id ?? null);
});

// SPA navigation between titles — re-announce so the enhancer resets
// onto the new episode's tracks.
let lastPath = window.location.pathname;
window.setInterval(() => {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    announceTracks();
  }
}, 1000);
