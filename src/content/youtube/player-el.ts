/**
 * The active YouTube player element, page-type aware.
 *
 * Watch pages (and `/live/<id>`) render `#movie_player`; Shorts render
 * `#shorts-player`. Both are the same `html5-video-player` class under
 * the hood, so the player API (`getOption` / `setOption` /
 * `getPlayerResponse` / `loadModule`) works against either. The
 * page-type switch matters because SPA navigation keeps the OTHER
 * surface's player mounted-but-hidden in the DOM — on a Shorts page a
 * `#movie_player` from an earlier watch view may still exist (and vice
 * versa), so "whichever element exists" picks the wrong player.
 *
 * Imported by both the MAIN-world cue script and the isolated-world
 * enhancer — keep this module dependency-free.
 */

export function isShortsPage(): boolean {
  return window.location.pathname.startsWith('/shorts/');
}

export function ytPlayerId(): 'shorts-player' | 'movie_player' {
  return isShortsPage() ? 'shorts-player' : 'movie_player';
}

export function ytPlayerEl(): HTMLElement | null {
  return document.getElementById(ytPlayerId());
}

/** Scoped `<video>` selector — never matches homepage hover previews
 *  or the preloaded prev/next reels a Shorts page keeps around. */
export function ytVideoSelector(): string {
  return `#${ytPlayerId()} video`;
}

export function ytVideoEl(): HTMLVideoElement | null {
  return ytPlayerEl()?.querySelector('video') ?? null;
}

/** Video id of the current page — `?v=` on watch pages, the path id on
 *  `/shorts/<id>` and `/live/<id>`. Empty string off player pages. */
export function ytPageVideoId(): string {
  const q = (window.location.search.match(/[?&]v=([^&]+)/) || [])[1];
  if (q) return q;
  const m = window.location.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/);
  return m?.[1] || '';
}
