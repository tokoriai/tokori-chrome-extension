/**
 * Immersion-time tracking ("study mode").
 *
 * The user explicitly starts a study session from the YouTube toolbar;
 * the content script then accrues active watch time (video actually
 * playing, unless `immersion.countWhilePaused` is on) and reports it to
 * the background worker as periodic heartbeat deltas. The background
 * owns persistence:
 *
 *   • `immersionActive`   — the single running session. Lives in
 *     chrome.storage.local (NOT session) so a browser crash still
 *     leaves enough state to finalize the time on next boot.
 *   • `immersionDays`     — ms of immersion per local calendar day.
 *     Powers the stats page without replaying every session.
 *   • `immersionSessions` — recent finished sessions (capped), each
 *     flagged with whether it was synced into the paired Tokori
 *     desktop's study_sessions table.
 *
 * Everything here is deliberately chrome-free and pure where possible
 * so the aggregation logic is unit-testable; the background worker does
 * the storage + messaging plumbing.
 */

export interface ImmersionActive {
  /** Epoch ms when the user hit start. */
  startedAt: number;
  /** Accrued immersion ms so far (excludes paused time unless the
   *  count-while-paused option was on in the reporting tab). */
  ms: number;
  /** Epoch ms of the last heartbeat — crash recovery finalizes the
   *  session here when the beats stop arriving. */
  lastBeatAt: number;
  /** Video/page title for the session log. */
  title: string | null;
  url: string | null;
  /** Id of the LIVE study_sessions row mirrored on the paired Tokori
   *  desktop (kind 'video'), when the start call succeeded. Sessions
   *  with a live row are finished in place and never re-logged through
   *  the one-shot fallback. */
  desktopSessionId?: number | null;
  /** True while the session's accrual is suspended — the video is
   *  paused (organic) or the desktop sidebar sent a pause command.
   *  Mirrored to the desktop as heartbeat `state` transitions so its
   *  chip freezes instead of guessing from beat silence. */
  paused?: boolean;
}

export interface ImmersionSessionEntry {
  /** Epoch ms — session start / end (wall clock, includes pauses). */
  start: number;
  end: number;
  /** Accrued immersion ms — what actually counts as study time. */
  ms: number;
  title: string | null;
  url: string | null;
  /** True once pushed into the paired Tokori desktop. Unsynced entries
   *  are retried on the next session end / worker boot. */
  synced: boolean;
}

/** ms per local calendar day, keyed 'YYYY-MM-DD'. */
export type ImmersionDayMap = Record<string, number>;

/** Sessions shorter than this are dropped on finalize — an accidental
 *  toggle shouldn't pollute the stats or the desktop's activity log. */
export const MIN_SESSION_MS = 5_000;

/** A single heartbeat can't credit more than this much time. Caps the
 *  damage of a clock jump or a buggy sender to one beat interval-ish. */
export const MAX_BEAT_MS = 120_000;

/** Active sessions whose beats stopped this long ago are considered
 *  dead (tab crashed / browser quit) and finalized at their last beat. */
export const STALE_ACTIVE_MS = 180_000;

/** Keep this many finished sessions in the log. Day totals are
 *  accumulated separately, so trimming old sessions loses no stats. */
export const MAX_SESSION_ENTRIES = 200;

/** Local calendar day key ('YYYY-MM-DD') for an epoch-ms timestamp.
 *  Local, not UTC — "today's immersion" must roll over at the user's
 *  midnight, matching the Tokori desktop's dashboard cut. */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Credit `ms` to the day containing `at` (mutates + returns `days`). */
export function addToDay(days: ImmersionDayMap, at: number, ms: number): ImmersionDayMap {
  if (ms <= 0) return days;
  const key = dayKey(at);
  days[key] = (days[key] || 0) + ms;
  return days;
}

/** Apply one heartbeat to the running session. Deltas are clamped to
 *  [0, MAX_BEAT_MS]; returns the updated session (new object). */
export function applyBeat(active: ImmersionActive, deltaMs: number, now: number): ImmersionActive {
  const delta = Math.min(Math.max(0, deltaMs), MAX_BEAT_MS);
  return { ...active, ms: active.ms + delta, lastBeatAt: now };
}

/** Accrual-state edge detector for the content-side ticker. Returns
 *  the new state when it flipped since the previous tick (→ send a
 *  `playing` transition on the next beat), null on steady state. A
 *  null `prev` (first tick of a session) is treated as playing —
 *  sessions start assumed-playing on the desktop, so only a session
 *  that begins paused produces an opening edge. */
export function accrualEdge(prev: boolean | null, next: boolean): boolean | null {
  return (prev ?? true) !== next ? next : null;
}

/** Turn the running session into a log entry ending at `endedAt`, or
 *  null when it's too short to be worth recording. */
export function finalizeActive(
  active: ImmersionActive,
  endedAt: number,
): ImmersionSessionEntry | null {
  if (active.ms < MIN_SESSION_MS) return null;
  return {
    start: active.startedAt,
    end: Math.max(endedAt, active.startedAt),
    ms: active.ms,
    title: active.title,
    url: active.url,
    synced: false,
  };
}

/** Prepend `entry` to the session log, trimming to the cap. */
export function pushSession(
  sessions: ImmersionSessionEntry[],
  entry: ImmersionSessionEntry,
): ImmersionSessionEntry[] {
  return [entry, ...sessions].slice(0, MAX_SESSION_ENTRIES);
}

/** Delete a logged session (identified by its start+end stamps): drop
 *  it from the log and hand its time back from the day totals — it was
 *  credited to the day containing its END (see finalizeImmersion). A
 *  drained day bucket is removed entirely so the map stays clean.
 *  Returns null when nothing matches (already deleted elsewhere) so
 *  callers can skip the write. */
export function removeSession(
  sessions: ImmersionSessionEntry[],
  days: ImmersionDayMap,
  start: number,
  end: number,
): { sessions: ImmersionSessionEntry[]; days: ImmersionDayMap } | null {
  const idx = sessions.findIndex((s) => s.start === start && s.end === end);
  if (idx === -1) return null;
  const removed = sessions[idx];
  const nextDays = { ...days };
  const key = dayKey(removed.end);
  const left = (nextDays[key] || 0) - removed.ms;
  if (left > 0) nextDays[key] = left;
  else delete nextDays[key];
  return { sessions: sessions.filter((_, i) => i !== idx), days: nextDays };
}

export interface ImmersionTotals {
  todayMs: number;
  week7Ms: number;
  month30Ms: number;
  allTimeMs: number;
}

/** Aggregate the day map into the stat-tile totals. Rolling 7/30-day
 *  windows include today. */
export function totals(days: ImmersionDayMap, now: number): ImmersionTotals {
  const out: ImmersionTotals = { todayMs: 0, week7Ms: 0, month30Ms: 0, allTimeMs: 0 };
  const today = dayKey(now);
  const dayMs = 86_400_000;
  const week = new Set<string>();
  const month = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const key = dayKey(now - i * dayMs);
    if (i < 7) week.add(key);
    month.add(key);
  }
  for (const [key, ms] of Object.entries(days)) {
    out.allTimeMs += ms;
    if (key === today) out.todayMs += ms;
    if (week.has(key)) out.week7Ms += ms;
    if (month.has(key)) out.month30Ms += ms;
  }
  return out;
}

/** Last `n` days as chart rows, oldest first, zero-filled. */
export function lastNDays(
  days: ImmersionDayMap,
  now: number,
  n: number,
): { key: string; ms: number }[] {
  const out: { key: string; ms: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86_400_000);
    out.push({ key, ms: days[key] || 0 });
  }
  return out;
}

/** "1h 24m" / "24m" / "45s" — stats + pill display. */
export function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

/** mm:ss / h:mm:ss ticking-timer display for the toolbar pill. */
export function formatTimer(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
