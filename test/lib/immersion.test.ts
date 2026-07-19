import { describe, it, expect } from 'vitest';
import {
  accrualEdge,
  addToDay,
  applyBeat,
  dayKey,
  finalizeActive,
  formatDuration,
  formatTimer,
  lastNDays,
  pushSession,
  removeSession,
  totals,
  MAX_BEAT_MS,
  MAX_SESSION_ENTRIES,
  MIN_SESSION_MS,
  type ImmersionActive,
  type ImmersionSessionEntry,
} from '@/lib/immersion';

const at = (iso: string) => new Date(iso).getTime();

function active(overrides: Partial<ImmersionActive> = {}): ImmersionActive {
  return {
    startedAt: at('2026-07-09T10:00:00'),
    ms: 60_000,
    lastBeatAt: at('2026-07-09T10:01:00'),
    title: 'Video',
    url: 'https://youtube.com/watch?v=x',
    ...overrides,
  };
}

describe('dayKey', () => {
  it('uses the LOCAL calendar day with zero-padding', () => {
    expect(dayKey(at('2026-07-09T00:00:01'))).toBe('2026-07-09');
    expect(dayKey(at('2026-01-05T23:59:59'))).toBe('2026-01-05');
  });
});

describe('addToDay', () => {
  it('accumulates into the day bucket and ignores non-positive credit', () => {
    const days = {};
    addToDay(days, at('2026-07-09T12:00:00'), 1000);
    addToDay(days, at('2026-07-09T18:00:00'), 500);
    addToDay(days, at('2026-07-09T18:00:00'), 0);
    addToDay(days, at('2026-07-09T18:00:00'), -50);
    expect(days).toEqual({ '2026-07-09': 1500 });
  });
});

describe('applyBeat', () => {
  it('adds the delta and stamps the beat time', () => {
    const next = applyBeat(active(), 10_000, at('2026-07-09T10:01:10'));
    expect(next.ms).toBe(70_000);
    expect(next.lastBeatAt).toBe(at('2026-07-09T10:01:10'));
  });

  it('clamps runaway deltas to MAX_BEAT_MS and negatives to zero', () => {
    expect(applyBeat(active(), 10 * 60_000, 0).ms).toBe(60_000 + MAX_BEAT_MS);
    expect(applyBeat(active(), -5000, 0).ms).toBe(60_000);
  });
});

describe('finalizeActive', () => {
  it('produces an unsynced log entry ending at endedAt', () => {
    const entry = finalizeActive(active(), at('2026-07-09T10:05:00'));
    expect(entry).toMatchObject({
      start: at('2026-07-09T10:00:00'),
      end: at('2026-07-09T10:05:00'),
      ms: 60_000,
      synced: false,
    });
  });

  it('drops sessions shorter than MIN_SESSION_MS (accidental toggles)', () => {
    expect(finalizeActive(active({ ms: MIN_SESSION_MS - 1 }), Date.now())).toBeNull();
  });

  it('never ends before it starts, even with a clock jump', () => {
    const entry = finalizeActive(active(), at('2026-07-09T09:00:00'));
    expect(entry!.end).toBe(entry!.start);
  });
});

describe('pushSession', () => {
  it('prepends and trims to the cap', () => {
    const filler: ImmersionSessionEntry[] = Array.from({ length: MAX_SESSION_ENTRIES }, (_, i) => ({
      start: i,
      end: i,
      ms: 10_000,
      title: null,
      url: null,
      synced: true,
    }));
    const fresh = finalizeActive(active(), at('2026-07-09T10:05:00'))!;
    const out = pushSession(filler, fresh);
    expect(out).toHaveLength(MAX_SESSION_ENTRIES);
    expect(out[0]).toBe(fresh);
  });
});

describe('removeSession', () => {
  const entry = (overrides: Partial<ImmersionSessionEntry> = {}): ImmersionSessionEntry => ({
    start: at('2026-07-09T10:00:00'),
    end: at('2026-07-09T10:30:00'),
    ms: 60_000,
    title: 'Video',
    url: null,
    synced: false,
    ...overrides,
  });

  it('drops the matching entry and refunds its ms from the END day', () => {
    const a = entry();
    const b = entry({ start: at('2026-07-08T10:00:00'), end: at('2026-07-08T10:10:00') });
    const days = { '2026-07-09': 90_000, '2026-07-08': 60_000 };
    const out = removeSession([a, b], days, a.start, a.end)!;
    expect(out.sessions).toEqual([b]);
    expect(out.days).toEqual({ '2026-07-09': 30_000, '2026-07-08': 60_000 });
  });

  it('deletes a drained day bucket instead of leaving 0 (or negative)', () => {
    const a = entry();
    expect(removeSession([a], { '2026-07-09': 60_000 }, a.start, a.end)!.days).toEqual({});
    // Day total smaller than the entry (edge: prior partial resets) —
    // never go negative.
    expect(removeSession([a], { '2026-07-09': 10_000 }, a.start, a.end)!.days).toEqual({});
  });

  it('returns null when nothing matches and leaves inputs untouched', () => {
    const a = entry();
    const days = { '2026-07-09': 60_000 };
    expect(removeSession([a], days, a.start, a.end + 1)).toBeNull();
    expect(days).toEqual({ '2026-07-09': 60_000 });
  });
});

describe('totals', () => {
  const now = at('2026-07-09T15:00:00');
  it('buckets today / rolling 7d / rolling 30d / all-time', () => {
    const days = {
      '2026-07-09': 1000, // today
      '2026-07-04': 2000, // within 7d
      '2026-06-20': 4000, // within 30d
      '2026-01-01': 8000, // ancient
    };
    expect(totals(days, now)).toEqual({
      todayMs: 1000,
      week7Ms: 3000,
      month30Ms: 7000,
      allTimeMs: 15000,
    });
  });

  it('is all zeroes for an empty map', () => {
    expect(totals({}, now)).toEqual({ todayMs: 0, week7Ms: 0, month30Ms: 0, allTimeMs: 0 });
  });
});

describe('lastNDays', () => {
  it('returns n zero-filled rows oldest-first ending today', () => {
    const now = at('2026-07-09T15:00:00');
    const rows = lastNDays({ '2026-07-08': 500 }, now, 3);
    expect(rows).toEqual([
      { key: '2026-07-07', ms: 0 },
      { key: '2026-07-08', ms: 500 },
      { key: '2026-07-09', ms: 0 },
    ]);
  });
});

describe('formatting', () => {
  it('formatDuration picks the coarsest sensible unit', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(24 * 60_000)).toBe('24m');
    expect(formatDuration(84 * 60_000)).toBe('1h 24m');
  });

  it('formatTimer renders m:ss then h:mm:ss', () => {
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(754_000)).toBe('12:34');
    expect(formatTimer(3_600_000 + 5 * 60_000 + 6_000)).toBe('1:05:06');
  });
});

describe('accrualEdge', () => {
  it('fires only when the state flips', () => {
    expect(accrualEdge(true, true)).toBeNull();
    expect(accrualEdge(false, false)).toBeNull();
    expect(accrualEdge(true, false)).toBe(false);
    expect(accrualEdge(false, true)).toBe(true);
  });

  it('treats the first tick as previously-playing', () => {
    // Sessions start assumed-playing on the desktop: only a session
    // that begins paused announces itself with an opening edge.
    expect(accrualEdge(null, true)).toBeNull();
    expect(accrualEdge(null, false)).toBe(false);
  });
});

describe('paused flag', () => {
  it('survives applyBeat untouched', () => {
    const active: ImmersionActive = {
      startedAt: 0,
      ms: 1_000,
      lastBeatAt: 0,
      title: null,
      url: null,
      paused: true,
    };
    expect(applyBeat(active, 500, 1_500).paused).toBe(true);
  });
});
