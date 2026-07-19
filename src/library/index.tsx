/**
 * Watch library — dedicated page (library.html).
 *
 * The extension-side view of the Immersion watch list: queued videos
 * with progress, a "watch next" hero, and the immersion-time stat
 * strip. Works with two data sources, never mixed:
 *   - Desktop paired  → the Tokori app's `/v1/media` list (the same
 *     items its Immersion view shows).
 *   - No desktop      → the in-browser store (src/lib/local-library.ts)
 *     that the ＋ Tokori button on YouTube fills and immersion beats
 *     keep advancing. Everything works without the desktop app.
 *
 * Live updates ride chrome.storage.onChanged (the background rewrites
 * the immersion + local-library keys on every beat) plus a slow
 * refetch for the desktop source.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Clock, ExternalLink, Monitor, Play, Trash2 } from 'lucide-react';

import { sendMsgAsync } from '../lib/chromeApi';
import { initPageTheme } from '../lib/theme';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { formatDuration, totals, type ImmersionDayMap } from '../lib/immersion';
import { groupLocalLibrary, localItemPercent, type LocalLibraryItem } from '../lib/local-library';
import { urlWithResume, ytThumbnail } from '../lib/media-key';
import type { LocalMediaItem } from '../lib/tokori-local';

import '../index.css';

initPageTheme();

/** One normalized card, whichever store it came from. */
interface LibraryCard {
  id: string;
  url: string | null;
  title: string;
  channel: string | null;
  /** 0–100, or null without a known length. */
  percent: number | null;
  /** Accrued watch/listen minutes. */
  minutes: number;
  /** Resume position in seconds, when one is known. */
  resumeSec: number | null;
  thumb: string | null;
  /** Only in-browser items can be removed from this page. */
  removable: boolean;
}

interface LibraryGroups {
  watching: LibraryCard[];
  upNext: LibraryCard[];
  finished: LibraryCard[];
}

function fromLocal(item: LocalLibraryItem): LibraryCard {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    channel: item.channel,
    percent: localItemPercent(item),
    minutes: Math.round(item.watchedMs / 60_000),
    resumeSec: item.positionSec > 0 ? item.positionSec : null,
    thumb: ytThumbnail(item.url),
    removable: true,
  };
}

function fromDesktop(item: LocalMediaItem): LibraryCard {
  const minutesUnit = /^min(ute)?s?$/i.test(item.unit_label.trim());
  const percent =
    item.total_units && item.total_units > 0
      ? Math.min(100, Math.max(0, (item.completed_units / item.total_units) * 100))
      : null;
  return {
    id: `desktop:${item.id}`,
    url: item.source,
    title: item.title,
    channel: item.author,
    percent,
    minutes: Math.round(item.total_seconds / 60),
    // Minute-tracked videos store the furthest minute — good enough to
    // resume near where the user left off.
    resumeSec: minutesUnit && item.completed_units > 0 ? item.completed_units * 60 : null,
    thumb: item.source ? ytThumbnail(item.source) : null,
    removable: false,
  };
}

function groupDesktop(items: LocalMediaItem[]): LibraryGroups {
  return {
    // Same shelf rules as the app's Immersion view: actives first,
    // paused after, each most-recently-touched first.
    watching: items
      .filter((i) => i.status === 'active' || i.status === 'paused')
      .sort(
        (a, b) =>
          Number(a.status === 'paused') - Number(b.status === 'paused') ||
          b.updated_at - a.updated_at,
      )
      .map(fromDesktop),
    upNext: items
      .filter((i) => i.status === 'planned')
      .sort((a, b) => a.created_at - b.created_at)
      .map(fromDesktop),
    finished: items.filter((i) => i.status === 'finished').map(fromDesktop),
  };
}

interface LibraryState {
  source: 'desktop' | 'local';
  groups: LibraryGroups;
  desktopError: string | null;
  loaded: boolean;
}

function useLibrary(): LibraryState & { removeItem: (id: string) => void } {
  const [state, setState] = useState<LibraryState>({
    source: 'local',
    groups: { watching: [], upNext: [], finished: [] },
    desktopError: null,
    loaded: false,
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await sendMsgAsync<{
        source: 'desktop' | 'local';
        items: unknown[];
        desktopError?: string;
      }>({ action: 'libraryList' });
      if (!alive || !res.success) return;
      const r = res as unknown as {
        source: 'desktop' | 'local';
        items: unknown[];
        desktopError?: string;
      };
      const groups =
        r.source === 'desktop'
          ? groupDesktop((r.items as LocalMediaItem[]) ?? [])
          : (() => {
              const g = groupLocalLibrary((r.items as LocalLibraryItem[]) ?? []);
              return {
                watching: g.watching.map(fromLocal),
                upNext: g.upNext.map(fromLocal),
                finished: g.finished.map(fromLocal),
              };
            })();
      setState({
        source: r.source,
        groups,
        desktopError: r.desktopError ?? null,
        loaded: true,
      });
    };
    void load();
    // Local store + immersion keys are rewritten on every beat — the
    // storage event is the live-update push channel. Desktop items
    // change out-of-band, hence the focus hook + slow tick.
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local') return;
      if ('localLibrary' in changes || 'immersionActive' in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, []);

  const removeItem = (id: string) => {
    setState((prev) => ({
      ...prev,
      groups: {
        watching: prev.groups.watching.filter((c) => c.id !== id),
        upNext: prev.groups.upNext.filter((c) => c.id !== id),
        finished: prev.groups.finished.filter((c) => c.id !== id),
      },
    }));
    void sendMsgAsync({ action: 'libraryRemove', id });
  };

  return { ...state, removeItem };
}

function useImmersionTotals() {
  const [days, setDays] = useState<ImmersionDayMap>({});
  const [liveMs, setLiveMs] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await sendMsgAsync<{ days: ImmersionDayMap; active: { ms: number } | null }>({
        action: 'immersionStats',
      });
      if (!alive || !res.success) return;
      const r = res as unknown as { days: ImmersionDayMap; active: { ms: number } | null };
      setDays(r.days || {});
      setLiveMs(r.active?.ms ?? 0);
    };
    void load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && ('immersionDays' in changes || 'immersionActive' in changes))
        void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return { days, liveMs };
}

function openCard(card: LibraryCard) {
  if (!card.url) return;
  void chrome.tabs.create({ url: urlWithResume(card.url, card.resumeSec) });
}

function LibraryPage() {
  const lib = useLibrary();
  const { days, liveMs } = useImmersionTotals();
  const t = useMemo(() => totals(days, Date.now()), [days]);
  const [showFinished, setShowFinished] = useState(false);

  const { watching, upNext, finished } = lib.groups;
  const empty = watching.length + upNext.length + finished.length === 0;
  // "Watch next": something mid-flight beats starting fresh; otherwise
  // the front of the queue.
  const next = watching[0] ?? upNext[0] ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-10 pb-24">
        {/* Header */}
        <div className="flex items-center gap-3">
          <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-9" />
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
            <p className="text-sm text-muted-foreground">
              Your watch queue with progress — added from the ＋ Tokori button on YouTube.
            </p>
          </div>
          <Badge
            variant="outline"
            className="gap-1.5"
            title={
              lib.source === 'desktop'
                ? "Reading the paired Tokori desktop workspace — the app's Immersion view shows the same list."
                : 'Stored in this browser. Pair the Tokori desktop app to move your library into a full workspace.'
            }
          >
            <Monitor className="size-3" aria-hidden />
            {lib.source === 'desktop' ? 'Desktop workspace' : 'In this browser'}
          </Badge>
          <a
            href={chrome.runtime.getURL('player.html')}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="Dual-subtitle player for local files and direct video URLs"
          >
            Player
          </a>
          <a
            href={chrome.runtime.getURL('stats.html')}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Stats
          </a>
        </div>

        {lib.desktopError && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            Tokori desktop is paired but not reachable right now — showing the in-browser library.
            Start the app to see your workspace list.
          </div>
        )}

        {/* Immersion time strip */}
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ['Today', t.todayMs + liveMs],
              ['This week', t.week7Ms + liveMs],
              ['All time', t.allTimeMs + liveMs],
            ] as const
          ).map(([label, ms]) => (
            <Card key={label}>
              <CardContent className="pt-5">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {label}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5 text-2xl font-semibold tabular-nums tracking-tight">
                  <Clock className="size-4 self-center text-muted-foreground" aria-hidden />
                  {formatDuration(ms)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {!lib.loaded ? null : empty ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <Clapperboard className="size-8 text-muted-foreground" aria-hidden />
              <div className="text-lg font-medium">Build your watch queue</div>
              <p className="max-w-sm text-sm text-muted-foreground">
                On any YouTube video, hit the <b>＋ Tokori</b> button next to like/Share. Queued
                videos land here with automatic progress tracking — the ⏱ timer starts by itself
                when you play them.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Watch next hero */}
            {next && (
              <Card>
                <CardContent className="flex items-center gap-4 pt-6">
                  {next.thumb && (
                    <img
                      src={next.thumb}
                      alt=""
                      className="h-24 w-40 shrink-0 rounded-lg object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Watch next
                    </div>
                    <div className="mt-0.5 truncate text-lg font-semibold">{next.title}</div>
                    {next.channel && (
                      <div className="truncate text-sm text-muted-foreground">{next.channel}</div>
                    )}
                    <ProgressLine card={next} className="mt-2" />
                  </div>
                  <Button onClick={() => openCard(next)} disabled={!next.url} className="shrink-0">
                    <Play data-icon="inline-start" />
                    {next.resumeSec ? 'Continue' : 'Watch'}
                  </Button>
                </CardContent>
              </Card>
            )}

            <Section
              title="Continue watching"
              cards={watching}
              onOpen={openCard}
              onRemove={lib.removeItem}
            />
            <Section title="Up next" cards={upNext} onOpen={openCard} onRemove={lib.removeItem} />
            {finished.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowFinished((v) => !v)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {showFinished ? 'Hide finished' : `Show ${finished.length} finished`}
                </button>
                {showFinished && (
                  <div className="mt-3">
                    <Section
                      title="Finished"
                      cards={finished}
                      onOpen={openCard}
                      onRemove={lib.removeItem}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  cards,
  onOpen,
  onRemove,
}: {
  title: string;
  cards: LibraryCard[];
  onOpen: (card: LibraryCard) => void;
  onRemove: (id: string) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section>
      <h2 className="flex items-baseline gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
        <span className="tabular-nums">{cards.length}</span>
      </h2>
      <div className="mt-2 flex flex-col gap-2">
        {cards.map((card) => (
          <Card key={card.id} className="group">
            <CardContent className="flex items-center gap-3 py-3">
              {card.thumb ? (
                <img
                  src={card.thumb}
                  alt=""
                  className="h-14 w-24 shrink-0 cursor-pointer rounded-md object-cover"
                  onClick={() => onOpen(card)}
                />
              ) : (
                <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Clapperboard className="size-5" aria-hidden />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div
                  className="cursor-pointer truncate text-sm font-medium hover:underline"
                  onClick={() => onOpen(card)}
                  title={card.title}
                >
                  {card.title}
                </div>
                {card.channel && (
                  <div className="truncate text-xs text-muted-foreground">{card.channel}</div>
                )}
                <ProgressLine card={card} className="mt-1.5" />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpen(card)}
                  disabled={!card.url}
                  title={card.url ? 'Open on YouTube' : 'No link stored'}
                >
                  <ExternalLink data-icon="inline-start" />
                  {card.resumeSec ? 'Continue' : 'Watch'}
                </Button>
                {card.removable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRemove(card.id)}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    title="Remove from the library"
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ProgressLine({ card, className }: { card: LibraryCard; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>{card.minutes > 0 ? `${card.minutes} min watched` : 'not started'}</span>
        {card.percent != null && <span className="tabular-nums">{Math.round(card.percent)}%</span>}
      </div>
      {card.percent != null && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-[var(--brand)]"
            style={{ width: `${Math.max(2, card.percent)}%` }}
          />
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<LibraryPage />);
