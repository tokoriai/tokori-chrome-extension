/**
 * In-browser watch library — the no-desktop fallback store.
 *
 * When the Tokori desktop app is paired, the extension's watch-list
 * writes go to its `/v1/media` API and the desktop's Immersion view is
 * the source of truth. Without a desktop, this module IS the library:
 * items live in `chrome.storage.local`, immersion beats advance their
 * progress, and the extension's library page (library.html) renders
 * them. The two sources are never mixed — pairing state picks one.
 *
 * Progress semantics mirror the desktop's `/v1/media/progress`
 * endpoint on purpose (same product, same rules):
 *   - furthest-watched position (scrubbing back never loses progress)
 *   - duration fills the denominator
 *   - planned → active on the first beat
 *   - ended / ≥90 % → finished; rewatching never un-finishes
 *
 * All exported mutators funnel through one serialized queue — the MV3
 * worker handles messages concurrently, and two read-modify-write
 * races on the same storage key would otherwise drop an update.
 */

import { canonicalMediaKey } from './media-key';

export type LocalLibraryStatus = 'planned' | 'active' | 'finished';

export interface LocalLibraryItem {
  /** Canonical media key (yt:<id>, …) — doubles as the identity. */
  id: string;
  url: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  /** Furthest playback position seen, seconds. */
  positionSec: number;
  /** Accrued active watch time, ms (immersion beats). */
  watchedMs: number;
  status: LocalLibraryStatus;
  addedAt: number;
  updatedAt: number;
}

export interface LocalLibraryBeat {
  deltaMs?: number;
  positionSec?: number;
  durationSec?: number;
  ended?: boolean;
}

const STORE_KEY = 'localLibrary';

// ── Pure derivations (unit-tested in test/lib/local-library.test.ts) ─

/** Unit progress as 0–100, or null without a denominator. */
export function localItemPercent(
  item: Pick<LocalLibraryItem, 'positionSec' | 'durationSec'>,
): number | null {
  if (!item.durationSec || item.durationSec <= 0) return null;
  return Math.min(100, Math.max(0, (item.positionSec / item.durationSec) * 100));
}

export function groupLocalLibrary(items: readonly LocalLibraryItem[]): {
  watching: LocalLibraryItem[];
  upNext: LocalLibraryItem[];
  finished: LocalLibraryItem[];
} {
  const byUpdatedDesc = (a: LocalLibraryItem, b: LocalLibraryItem) => b.updatedAt - a.updatedAt;
  return {
    watching: items.filter((i) => i.status === 'active').sort(byUpdatedDesc),
    // Queue order: first added, first up — same rule as the desktop view.
    upNext: items.filter((i) => i.status === 'planned').sort((a, b) => a.addedAt - b.addedAt),
    finished: items.filter((i) => i.status === 'finished').sort(byUpdatedDesc),
  };
}

/** Apply one playback beat to an item — the desktop progress rules. */
export function applyBeatToItem(
  item: LocalLibraryItem,
  beat: LocalLibraryBeat,
  now: number,
): LocalLibraryItem {
  const next: LocalLibraryItem = { ...item, updatedAt: now };
  if (beat.deltaMs && beat.deltaMs > 0) {
    // Clamp like the desktop endpoint — a buggy client can't mint an
    // hour per beat.
    next.watchedMs += Math.min(beat.deltaMs, 3_600_000);
  }
  if (beat.durationSec && beat.durationSec > 0) {
    next.durationSec = Math.max(next.durationSec ?? 0, Math.round(beat.durationSec));
  }
  if (beat.positionSec && beat.positionSec > 0) {
    next.positionSec = Math.max(next.positionSec, Math.round(beat.positionSec));
    if (next.durationSec) next.positionSec = Math.min(next.positionSec, next.durationSec);
  }
  const reachedEnd =
    !!beat.ended ||
    (beat.positionSec != null &&
      !!next.durationSec &&
      next.durationSec > 0 &&
      beat.positionSec * 10 >= next.durationSec * 9);
  if (item.status === 'finished') {
    // Rewatching never un-finishes; the extra minutes still count.
  } else if (reachedEnd) {
    next.status = 'finished';
    if (next.durationSec) next.positionSec = next.durationSec;
  } else {
    // A beat means it's playing — planned items move onto the shelf.
    next.status = 'active';
  }
  return next;
}

// ── Storage plumbing ─────────────────────────────────────────────────

async function readAll(): Promise<LocalLibraryItem[]> {
  try {
    const stored = await chrome.storage.local.get(STORE_KEY);
    const raw = stored[STORE_KEY];
    return Array.isArray(raw) ? (raw as LocalLibraryItem[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: LocalLibraryItem[]): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: items });
}

/** Serialize mutations — see the header note on MV3 races. */
let mutationQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

export function listLocalLibrary(): Promise<LocalLibraryItem[]> {
  return readAll();
}

/** Add (idempotent on the canonical key — re-adding returns the
 *  existing row, mirroring the desktop endpoint's contract). */
export function addLocalLibraryItem(input: {
  url: string;
  title: string;
  channel?: string | null;
  durationSec?: number | null;
}): Promise<{ item: LocalLibraryItem; existed: boolean }> {
  return enqueue(async () => {
    const key = canonicalMediaKey(input.url);
    if (!key) throw new Error('Not a recognizable media URL.');
    const items = await readAll();
    const existing = items.find((i) => i.id === key);
    if (existing) return { item: existing, existed: true };
    const now = Date.now();
    const item: LocalLibraryItem = {
      id: key,
      url: input.url,
      title: input.title.trim() || input.url,
      channel: input.channel?.trim() || null,
      durationSec:
        input.durationSec && input.durationSec > 0 ? Math.round(input.durationSec) : null,
      positionSec: 0,
      watchedMs: 0,
      status: 'planned',
      addedAt: now,
      updatedAt: now,
    };
    await writeAll([...items, item]);
    return { item, existed: false };
  });
}

export function removeLocalLibraryItem(id: string): Promise<boolean> {
  return enqueue(async () => {
    const items = await readAll();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length) return false;
    await writeAll(next);
    return true;
  });
}

export function lookupLocalLibrary(url: string): Promise<LocalLibraryItem | null> {
  return readAll().then((items) => {
    const key = canonicalMediaKey(url);
    if (!key) return null;
    return items.find((i) => i.id === key) ?? null;
  });
}

/** Advance the matching item's progress; false when the URL isn't on
 *  the list (speculative beats are the normal case — every watched
 *  video reports, only list members accrue). */
export function applyLocalLibraryBeat(url: string, beat: LocalLibraryBeat): Promise<boolean> {
  return enqueue(async () => {
    const key = canonicalMediaKey(url);
    if (!key) return false;
    const items = await readAll();
    const idx = items.findIndex((i) => i.id === key);
    if (idx < 0) return false;
    const next = [...items];
    next[idx] = applyBeatToItem(items[idx], beat, Date.now());
    await writeAll(next);
    return true;
  });
}
