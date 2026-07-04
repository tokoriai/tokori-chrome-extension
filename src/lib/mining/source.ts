/**
 * MiningSource — site-agnostic snapshot of "what's on screen right now"
 * for the sentence miner.
 *
 * The YouTube enhancer registers a getter on `window` that returns the
 * latest snapshot each tick; the MiningModal calls `getMiningSource()`
 * to read it without coupling to YT internals. A future Netflix
 * enhancer registers the same getter under the same key — the modal
 * doesn't need to branch.
 */

import type { LanguageCode } from '../languages';

export interface CueSnapshot {
  text: string;
  /** Best-guess BCP-47 short code via `detectLanguage`. */
  lang: LanguageCode;
  /** Cue's playback range. `endSec` lets the miner default-record a
   *  clip that covers the spoken line and not much more. */
  startSec: number;
  endSec: number;
}

export interface MiningSource {
  siteId: 'youtube' | 'netflix' | 'generic';
  /** The page's title (or scraped product-specific title — YT video
   *  title for YouTube, episode title for Netflix). May be null on
   *  pages that don't expose one. */
  title: string | null;
  /** Canonical URL with timing fragment if applicable (?t=… on YT). */
  sourceUrl: string;
  /** The active native-language cue. Null when CC is paused/missing. */
  currentCue: CueSnapshot | null;
  /** Active translated cue (e.g. English when the native is Chinese).
   *  Used to pre-fill the translation field. Null when no translation
   *  track is available. */
  currentTranslatedCue: { text: string } | null;
  /** Underlying `<video>` element — the capture helpers need it. */
  video: HTMLVideoElement | null;
  /** Sources whose ToS forbid sending raw media to a third-party server
   *  set this. The mining modal disables the Tokori-cloud target when
   *  it's true (Netflix), so the user can only save locally. */
  requiresLocalOnly: boolean;
}

declare global {
  interface Window {
    __tokoriMiningSource?: () => MiningSource | null;
  }
}

/** Site enhancers call this once on mount to register a snapshot getter.
 *  Returns a deregister fn so unmount can clean up. */
export function registerMiningSource(getter: () => MiningSource | null): () => void {
  window.__tokoriMiningSource = getter;
  return () => {
    if (window.__tokoriMiningSource === getter) {
      delete window.__tokoriMiningSource;
    }
  };
}

/** Read the latest snapshot, or null if no site enhancer is mounted on
 *  the current page (e.g. the user opened the modal from a generic
 *  page via the popup's Mine button). */
export function getMiningSource(): MiningSource | null {
  try {
    return window.__tokoriMiningSource?.() || null;
  } catch {
    return null;
  }
}
