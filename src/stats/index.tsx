/**
 * Immersion statistics — dedicated page (stats.html).
 *
 * One scrollable column: hero (today), stat tiles, a 14-day bar chart,
 * the recent-session log, and the tracking options. Data comes from
 * the background's `immersionStats` action and updates live through
 * chrome.storage.onChanged — the background rewrites the immersion
 * keys on every heartbeat, so a running session ticks here without
 * polling.
 *
 * Everything works without the Tokori desktop; when a desktop is
 * paired, finished sessions are additionally mirrored into its
 * study_sessions table (the ✓ next to a session marks that).
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { Clock, Monitor, Check, Timer, Play, Trash2 } from 'lucide-react';

import { sendMsgAsync } from '../lib/chromeApi';
import { initPageTheme } from '../lib/theme';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings';
import {
  formatDuration,
  lastNDays,
  totals,
  type ImmersionActive,
  type ImmersionDayMap,
  type ImmersionSessionEntry,
} from '../lib/immersion';

import '../index.css';

initPageTheme();

/** Chart series color. Light mode uses the brand token as-is; dark
 *  mode uses a slightly deeper step than the dark brand token —
 *  `oklch(0.66 0.18 280)` — which passes the palette validator's
 *  lightness band + contrast checks against the dark surface. */
const CHART_BAR_CSS = `
:root { --stats-bar: var(--brand); }
html.dark { --stats-bar: oklch(0.66 0.18 280); }
`;

interface StatsPayload {
  active: ImmersionActive | null;
  days: ImmersionDayMap;
  sessions: ImmersionSessionEntry[];
}

function useImmersionStats(): StatsPayload {
  const [data, setData] = useState<StatsPayload>({ active: null, days: {}, sessions: [] });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await sendMsgAsync<StatsPayload>({ action: 'immersionStats' });
      if (alive && res.success) {
        const r = res as unknown as StatsPayload & { success: true };
        setData({ active: r.active, days: r.days || {}, sessions: r.sessions || [] });
      }
    };
    void load();
    // The background rewrites these keys on every heartbeat / stop —
    // storage.onChanged is our live-update push channel.
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local') return;
      if (
        'immersionActive' in changes ||
        'immersionDays' in changes ||
        'immersionSessions' in changes
      )
        void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return data;
}

function Stats() {
  const { active, days, sessions } = useImmersionStats();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    void sendMsgAsync<Settings>({ action: 'getSettings' }).then((res) => {
      if (res.success) {
        const data = (res as { data?: Settings }).data;
        if (data) setSettings(data);
      }
    });
  }, []);

  const now = Date.now();
  const liveMs = active?.ms ?? 0;
  const t = useMemo(() => totals(days, now), [days, now]);
  const chartDays = useMemo(() => lastNDays(days, now, 14), [days, now]);
  const desktopPaired = !!settings.localApi.token && settings.localWorkspaceId != null;

  const patchImmersion = async (patch: Partial<Settings['immersion']>) => {
    const next = { ...settings, immersion: { ...settings.immersion, ...patch } };
    setSettings(next);
    await sendMsgAsync({ action: 'patchSettings', patch: { immersion: next.immersion } });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <style>{CHART_BAR_CSS}</style>
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-10 pb-24">
        {/* Header */}
        <div className="flex items-center gap-3">
          <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-9" />
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Immersion</h1>
            <p className="text-sm text-muted-foreground">
              Active watch time tracked with the ⏱ study-mode pill on YouTube.
            </p>
          </div>
          {active && (
            <Badge className="gap-1.5 bg-[var(--success)] text-[var(--success-foreground)]">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-current" />
              </span>
              Session running
            </Badge>
          )}
          <a
            href={chrome.runtime.getURL('library.html')}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="Your watch library — queued videos with progress"
          >
            Library
          </a>
        </div>

        {/* Hero: today */}
        <Card>
          <CardContent className="flex items-end justify-between gap-4 pt-6">
            <div>
              <div className="text-sm font-medium text-muted-foreground">Today</div>
              <div className="mt-1 text-5xl font-semibold tabular-nums tracking-tight">
                {formatDuration(t.todayMs + liveMs)}
              </div>
              {active ? (
                <div className="mt-2 text-sm text-muted-foreground">
                  {formatDuration(liveMs)} in the running session
                  {active.title ? <> — “{active.title}”</> : null}
                </div>
              ) : (
                <div className="mt-2 text-sm text-muted-foreground">
                  {t.todayMs === 0
                    ? 'No immersion logged yet today. Open a YouTube video and hit ⏱ Immerse.'
                    : 'Timer is stopped — start it from the YouTube caption toolbar.'}
                </div>
              )}
            </div>
            <Timer className="mb-1 size-10 text-[var(--stats-bar)]" aria-hidden />
          </CardContent>
        </Card>

        {/* Tiles */}
        <div className="grid grid-cols-3 gap-4">
          <Tile label="Last 7 days" value={formatDuration(t.week7Ms + liveMs)} />
          <Tile label="Last 30 days" value={formatDuration(t.month30Ms + liveMs)} />
          <Tile label="All time" value={formatDuration(t.allTimeMs + liveMs)} />
        </div>

        {/* Chart */}
        <Card>
          <CardContent className="pt-6">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Last 14 days</h2>
              <span className="text-xs text-muted-foreground">per-day immersion</span>
            </div>
            <DayBarChart rows={chartDays} liveMs={liveMs} />
          </CardContent>
        </Card>

        {/* Sessions */}
        <Card>
          <CardContent className="pt-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Recent sessions</h2>
              {desktopPaired && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3.5" aria-hidden /> = mirrored to Tokori desktop
                </span>
              )}
            </div>
            {sessions.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Nothing logged yet. Sessions appear here when you stop the timer (or close the tab).
              </p>
            ) : (
              <ul className="divide-y">
                {sessions.slice(0, 25).map((s) => (
                  <SessionRow
                    key={`${s.start}-${s.end}`}
                    s={s}
                    desktopPaired={desktopPaired}
                    onDelete={() =>
                      void sendMsgAsync({
                        action: 'immersionDeleteSession',
                        start: s.start,
                        end: s.end,
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Options */}
        <Card>
          <CardContent className="flex flex-col gap-5 pt-6">
            <h2 className="text-sm font-semibold">Tracking options</h2>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="count-paused" className="text-sm font-medium">
                  Keep counting while the video is paused
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Off (default): pausing the video pauses the timer, so only real watch time counts.
                  On: the timer runs wall-clock until you stop it — for pause-and-repeat or
                  shadowing routines.
                </p>
              </div>
              <Switch
                id="count-paused"
                checked={settings.immersion.countWhilePaused}
                onCheckedChange={(v) => void patchImmersion({ countWhilePaused: !!v })}
              />
            </div>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="auto-start-listed" className="text-sm font-medium">
                  Auto-start the timer for library videos
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  When a video from your watch library starts playing, the immersion timer starts by
                  itself — and with it, the video's progress tracking. Stopping the timer manually
                  pauses the auto-start until you navigate away.
                </p>
              </div>
              <Switch
                id="auto-start-listed"
                checked={settings.immersion.autoStartListed !== false}
                onCheckedChange={(v) => void patchImmersion({ autoStartListed: !!v })}
              />
            </div>
            <div className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden />
              {desktopPaired ? (
                <span>
                  Desktop paired — starting the timer also starts a live “Video / TV” session in
                  your Tokori workspace, so the desktop dashboard, heatmap, streak, and Activities
                  view track this time.
                </span>
              ) : (
                <span>
                  Stats are stored locally in the extension. Pair the Tokori desktop app (Options →
                  Tokori desktop) to also mirror sessions into its dashboard — nothing is lost
                  either way.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Play className="size-3.5" aria-hidden />
          Start / stop the timer from the caption toolbar on any YouTube video. Sessions shorter
          than 5 seconds are discarded.
        </p>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      </CardContent>
    </Card>
  );
}

function SessionRow({
  s,
  desktopPaired,
  onDelete,
}: {
  s: ImmersionSessionEntry;
  desktopPaired: boolean;
  onDelete: () => void;
}) {
  // Two-click delete: first click arms the red confirm, which disarms
  // by itself if the second click doesn't come — no modal needed for a
  // single log row.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirming]);
  const startDate = new Date(s.start);
  const dateLabel = startDate.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const timeLabel = startDate.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <li className="group flex items-center gap-3 py-2.5">
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{s.title || s.url || 'Untitled session'}</div>
        <div className="text-xs text-muted-foreground">
          {dateLabel} · {timeLabel}
        </div>
      </div>
      {desktopPaired && s.synced && (
        <Check className="size-4 shrink-0 text-[var(--success)]" aria-label="Synced to desktop" />
      )}
      <Badge variant="secondary" className="shrink-0 tabular-nums">
        {formatDuration(s.ms)}
      </Badge>
      {confirming ? (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground"
          title={
            desktopPaired && s.synced
              ? 'Remove this session and its time from the stats. The copy already mirrored to the Tokori desktop stays there.'
              : 'Remove this session and its time from the stats.'
          }
        >
          Delete?
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
          aria-label="Delete session"
          title="Delete this session"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

// ── Chart ───────────────────────────────────────────────────────────
//
// Single-series magnitude over time → simple vertical bars. Marks per
// the dataviz method: bars anchored to the baseline with a 4px rounded
// top, thin (62% of slot), recessive gridlines, no legend (one series,
// the card title names it), hover tooltip on a full-slot hit target,
// and a selective direct label on today's bar only.

const CHART_W = 700;
const CHART_H = 190;
const PAD_LEFT = 40;
const PAD_BOTTOM = 22;
const PAD_TOP = 18;

function niceMaxMinutes(maxMin: number): number {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720];
  for (const s of steps) if (maxMin <= s) return s;
  return Math.ceil(maxMin / 240) * 240;
}

function gridLabel(min: number): string {
  return min % 60 === 0 && min >= 60 ? `${min / 60}h` : formatDuration(min * 60_000);
}

function DayBarChart({ rows, liveMs }: { rows: { key: string; ms: number }[]; liveMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Fold the running session into today's bar so the chart matches the
  // hero number.
  const todayIdx = rows.length - 1;
  const values = rows.map((r, i) => r.ms + (i === todayIdx ? liveMs : 0));
  const maxMin = niceMaxMinutes(Math.max(15, ...values.map((v) => v / 60_000)));
  const plotW = CHART_W - PAD_LEFT - 8;
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const slotW = plotW / rows.length;
  const barW = Math.min(28, slotW * 0.62);
  const yFor = (ms: number) => PAD_TOP + plotH * (1 - ms / 60_000 / maxMin);
  const grid = [maxMin / 3, (2 * maxMin) / 3, maxMin].map((m) => Math.round(m));
  const empty = values.every((v) => v === 0);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        role="img"
        aria-label="Immersion minutes per day, last 14 days"
      >
        {/* Gridlines + y labels — recessive */}
        {grid.map((m) => (
          <g key={m}>
            <line
              x1={PAD_LEFT}
              x2={CHART_W - 8}
              y1={yFor(m * 60_000)}
              y2={yFor(m * 60_000)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={PAD_LEFT - 8}
              y={yFor(m * 60_000) + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted-foreground)"
            >
              {gridLabel(m)}
            </text>
          </g>
        ))}
        {/* Baseline */}
        <line
          x1={PAD_LEFT}
          x2={CHART_W - 8}
          y1={PAD_TOP + plotH}
          y2={PAD_TOP + plotH}
          stroke="var(--border)"
          strokeWidth="1"
        />
        {rows.map((r, i) => {
          const v = values[i];
          const x = PAD_LEFT + i * slotW + (slotW - barW) / 2;
          const y = yFor(v);
          const h = PAD_TOP + plotH - y;
          const d = new Date(`${r.key}T12:00:00`);
          const isToday = i === todayIdx;
          return (
            <g
              key={r.key}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((prev) => (prev === i ? null : prev))}
            >
              {/* Full-slot hit target — bigger than the mark. */}
              <rect
                x={PAD_LEFT + i * slotW}
                y={PAD_TOP}
                width={slotW}
                height={plotH}
                fill="transparent"
              />
              {v > 0 ? (
                <path d={roundedTopBar(x, y, barW, h, 4)} fill="var(--stats-bar)" />
              ) : (
                // Zero-day stub so "nothing" reads as zero, not missing.
                <rect
                  x={x}
                  y={PAD_TOP + plotH - 2}
                  width={barW}
                  height="2"
                  rx="1"
                  fill="var(--border)"
                />
              )}
              {/* Selective direct label: today only. */}
              {isToday && v > 0 && (
                <text
                  x={x + barW / 2}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="600"
                  fill="var(--foreground)"
                >
                  {formatDuration(v)}
                </text>
              )}
              {/* X labels: every other day + today. */}
              {(i % 2 === todayIdx % 2 || isToday) && (
                <text
                  x={PAD_LEFT + i * slotW + slotW / 2}
                  y={CHART_H - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight={isToday ? 600 : 400}
                  fill={isToday ? 'var(--foreground)' : 'var(--muted-foreground)'}
                >
                  {isToday
                    ? 'Today'
                    : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No immersion in the last 14 days yet.
        </div>
      )}
      {hover != null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{
            left: `${((PAD_LEFT + hover * slotW + slotW / 2) / CHART_W) * 100}%`,
            top: 0,
          }}
        >
          <div className="font-medium">
            {new Date(`${rows[hover].key}T12:00:00`).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </div>
          <div className="tabular-nums text-muted-foreground">
            {values[hover] > 0 ? formatDuration(values[hover]) : 'No immersion'}
          </div>
        </div>
      )}
    </div>
  );
}

/** Bar path anchored at the baseline with only the top corners rounded
 *  (radius shrinks for very short bars so tiny values stay honest). */
function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return [
    `M ${x} ${y + h}`,
    `L ${x} ${y + rr}`,
    `Q ${x} ${y} ${x + rr} ${y}`,
    `L ${x + w - rr} ${y}`,
    `Q ${x + w} ${y} ${x + w} ${y + rr}`,
    `L ${x + w} ${y + h}`,
    'Z',
  ].join(' ');
}

createRoot(document.getElementById('root')!).render(<Stats />);
