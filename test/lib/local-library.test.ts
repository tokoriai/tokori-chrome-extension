import { describe, expect, it } from 'vitest';
import {
  applyBeatToItem,
  groupLocalLibrary,
  localItemPercent,
  type LocalLibraryItem,
} from '@/lib/local-library';

let nextId = 1;
function item(overrides: Partial<LocalLibraryItem> = {}): LocalLibraryItem {
  const n = nextId++;
  return {
    id: `yt:video${n}`,
    url: `https://www.youtube.com/watch?v=video${n}`,
    title: `Video ${n}`,
    channel: null,
    durationSec: null,
    positionSec: 0,
    watchedMs: 0,
    status: 'planned',
    addedAt: 1000 + n,
    updatedAt: 1000 + n,
    ...overrides,
  };
}

describe('applyBeatToItem', () => {
  // Same rules as the desktop's /v1/media/progress endpoint.
  it('promotes planned → active on the first beat and accrues time', () => {
    const next = applyBeatToItem(item(), { deltaMs: 10_000, positionSec: 60 }, 5000);
    expect(next.status).toBe('active');
    expect(next.watchedMs).toBe(10_000);
    expect(next.positionSec).toBe(60);
    expect(next.updatedAt).toBe(5000);
  });

  it('keeps furthest-watched position — scrubbing back never loses progress', () => {
    const base = item({ status: 'active', positionSec: 300 });
    expect(applyBeatToItem(base, { positionSec: 120 }, 1).positionSec).toBe(300);
    expect(applyBeatToItem(base, { positionSec: 400 }, 1).positionSec).toBe(400);
  });

  it('fills the duration denominator and clamps position to it', () => {
    const next = applyBeatToItem(item(), { positionSec: 500, durationSec: 400 }, 1);
    expect(next.durationSec).toBe(400);
    expect(next.positionSec).toBe(400);
  });

  it('finishes at the 90% mark or on ended, and never un-finishes', () => {
    const nearEnd = applyBeatToItem(item({ durationSec: 100 }), { positionSec: 92 }, 1);
    expect(nearEnd.status).toBe('finished');
    expect(nearEnd.positionSec).toBe(100);

    const ended = applyBeatToItem(item(), { ended: true }, 1);
    expect(ended.status).toBe('finished');

    const rewatch = applyBeatToItem(
      item({ status: 'finished', durationSec: 100, positionSec: 100 }),
      { deltaMs: 5000, positionSec: 10 },
      1,
    );
    expect(rewatch.status).toBe('finished');
    expect(rewatch.watchedMs).toBe(5000);
  });

  it('clamps a runaway delta to one hour per beat', () => {
    const next = applyBeatToItem(item(), { deltaMs: 999_999_999 }, 1);
    expect(next.watchedMs).toBe(3_600_000);
  });
});

describe('groupLocalLibrary', () => {
  it('routes statuses to shelves with the right ordering', () => {
    const queuedSecond = item({ status: 'planned', addedAt: 200 });
    const queuedFirst = item({ status: 'planned', addedAt: 100 });
    const staleActive = item({ status: 'active', updatedAt: 10 });
    const freshActive = item({ status: 'active', updatedAt: 99 });
    const done = item({ status: 'finished' });
    const g = groupLocalLibrary([queuedSecond, done, staleActive, queuedFirst, freshActive]);
    expect(g.watching).toEqual([freshActive, staleActive]);
    expect(g.upNext).toEqual([queuedFirst, queuedSecond]);
    expect(g.finished).toEqual([done]);
  });
});

describe('localItemPercent', () => {
  it('derives percent from position/duration, null without a length', () => {
    expect(localItemPercent({ positionSec: 50, durationSec: 200 })).toBe(25);
    expect(localItemPercent({ positionSec: 500, durationSec: 200 })).toBe(100);
    expect(localItemPercent({ positionSec: 50, durationSec: null })).toBeNull();
  });
});
