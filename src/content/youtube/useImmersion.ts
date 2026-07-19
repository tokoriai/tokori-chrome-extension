/**
 * useImmersionTimer — content-script side of the immersion tracker.
 *
 * The user starts "study mode" from the toolbar's ⏱ pill (or it
 * auto-starts for library videos); while it is on, this hook accrues
 * time once per second — but ONLY while the current video is on the
 * user's watch library (`countable`). A session left running while the
 * user browses other videos accrues nothing: the tracker answers "how
 * long did I study my library queue", not "how long was YouTube open".
 * Within a countable video, time counts while the player actually
 * plays (or unconditionally when the `countWhilePaused` setting is on).
 *
 * Accrued time flushes to the background as an `immersionBeat` roughly
 * every 10 s — plus a final flush on stop / pagehide so short tails
 * aren't lost. Page + playback context is captured at ACCRUAL time,
 * not flush time, so a beat that fires after the user navigated away
 * still attributes its seconds (and the session label) to the video
 * they were actually watched on. While nothing accrues, the 10 s beat
 * still fires as a bare keepalive (deltaMs 0, no page context) so the
 * background doesn't mistake a browsing detour for a dead session.
 * The background owns persistence and the desktop push; see
 * background.ts's immersion section.
 *
 * Desktop sync (bidirectional):
 *   • Accrual-state EDGES (video paused/resumed) flush immediately
 *     with a `playing` flag — the background relays them as heartbeat
 *     transitions so the desktop's sidebar chip freezes/unfreezes
 *     within a second instead of guessing from beat silence.
 *   • While active, the hook polls `immersionControlPoll` every ~3 s.
 *     A desktop-issued `pause`/`resume` command comes back and is
 *     applied to the actual player element; `endRequested` means the
 *     user hit End on the desktop chip — the hook stops the session
 *     through the normal tail-flushing stop path and fires
 *     `onRemoteEnd` so the toolbar can suppress its auto-restart.
 *   • A desktop pause also gates accrual directly (`sessionPaused`),
 *     so even a player we fail to pause — or a count-while-paused
 *     setup — stops counting until resumed from either side.
 *
 * The hook also adopts an already-running session on mount (SPA
 * navigation, reload, or a second tab) so the pill shows the ticking
 * timer instead of silently starting a parallel count.
 */

import { useEffect, useRef, useState } from 'react';
import { sendMsg } from '../../lib/chromeApi';
import { accrualEdge } from '../../lib/immersion';
import { ytVideoEl } from './player-el';
import type { Settings } from '../../lib/settings';

const BEAT_FLUSH_MS = 10_000;
const CONTROL_POLL_MS = 3_000;

interface ImmersionPillState {
  active: boolean;
  /** Accrued ms of the running session (background total + local
   *  not-yet-flushed remainder) — drives the ticking pill label. */
  ms: number;
  /** Session-level paused flag (organic video pause or desktop
   *  command) — drives the pill's ⏸ hint. */
  paused: boolean;
}

/** Page + playback snapshot taken whenever time is credited. */
interface AccrualContext {
  title: string;
  url: string;
  positionSec?: number;
  durationSec?: number;
  ended?: boolean;
}

export function useImmersionTimer(
  enabled: boolean,
  countable: boolean,
  /** Fired when the session ended remotely (desktop End, or stopped in
   *  another tab) rather than via this tab's toggle — the caller uses
   *  it to suppress its listed-video auto-restart. */
  onRemoteEnd?: () => void,
): {
  active: boolean;
  ms: number;
  paused: boolean;
  toggle: () => void;
} {
  const [state, setState] = useState<ImmersionPillState>({
    active: false,
    ms: 0,
    paused: false,
  });
  /** ms accrued locally since the last successful beat. */
  const pendingRef = useRef(0);
  const countWhilePausedRef = useRef(false);
  /** Live mirror of `countable` so the 1 s ticker reads the current
   *  value without re-arming its interval on every lookup. */
  const countableRef = useRef(countable);
  countableRef.current = countable;
  /** Where the pending ms were accrued — beats/stop report this, not
   *  wherever the user happens to be when the flush fires. */
  const ctxRef = useRef<AccrualContext | null>(null);
  /** Background-confirmed session paused state. Gates accrual (a
   *  desktop pause stops the count even if the player kept going) and
   *  lets a raw play press read as an explicit resume intent. */
  const sessionPausedRef = useRef(false);
  /** Last accrual state reported to the background (edge detection). */
  const lastAccrualRef = useRef<boolean | null>(null);
  const lastRawPlayingRef = useRef<boolean | null>(null);
  const onRemoteEndRef = useRef(onRemoteEnd);
  onRemoteEndRef.current = onRemoteEnd;

  const refreshPauseSetting = () => {
    sendMsg({ action: 'getSettings' }, (res) => {
      if (!res?.success) return;
      const s = (res as unknown as { data?: Settings }).data;
      if (s) countWhilePausedRef.current = !!s.immersion?.countWhilePaused;
    });
  };

  const resetSessionRefs = () => {
    pendingRef.current = 0;
    sessionPausedRef.current = false;
    lastAccrualRef.current = null;
    lastRawPlayingRef.current = null;
  };

  const applyServerPaused = (paused: boolean) => {
    sessionPausedRef.current = paused;
    setState((prev) => (prev.paused === paused ? prev : { ...prev, paused }));
  };

  // Adopt a session that's already running (reload / SPA nav / other
  // tab started it).
  useEffect(() => {
    if (!enabled) return;
    sendMsg({ action: 'immersionState' }, (res) => {
      const r = res as unknown as
        { success?: boolean; active?: boolean; ms?: number; paused?: boolean } | undefined;
      if (r?.success && r.active) {
        refreshPauseSetting();
        sessionPausedRef.current = !!r.paused;
        setState({ active: true, ms: r.ms || 0, paused: !!r.paused });
      }
    });
  }, [enabled]);

  // 1 s ticker while active: accrue countable playing time locally,
  // flush to the background every BEAT_FLUSH_MS (immediately on an
  // accrual-state edge, so the desktop chip flips fast).
  useEffect(() => {
    if (!enabled || !state.active) return;
    let last = Date.now();
    let sinceFlush = 0;

    const flush = (keepalive = false, transition: boolean | null = null) => {
      const delta = pendingRef.current;
      if (delta <= 0 && !keepalive && transition == null) return;
      pendingRef.current = 0;
      const ctx = delta > 0 ? ctxRef.current : null;
      sendMsg(
        {
          action: 'immersionBeat',
          deltaMs: delta,
          // Accrual-time context: the video the seconds belong to. A
          // bare keepalive (no accrual since the last beat) sends none,
          // so the background neither renames the session nor moves
          // watch-list progress while the user is off browsing.
          ...(ctx ?? {}),
          // Edge-only: present exactly when the accrual state flipped.
          ...(transition == null ? {} : { playing: transition }),
        },
        (res) => {
          const r = res as unknown as {
            success?: boolean;
            active?: boolean;
            ms?: number;
            paused?: boolean;
          };
          if (r?.success && r.active === false) {
            // Stopped elsewhere — flip the pill off.
            resetSessionRefs();
            setState({ active: false, ms: 0, paused: false });
            onRemoteEndRef.current?.();
          } else if (r?.success && typeof r.ms === 'number') {
            // Re-anchor on the background's authoritative total.
            if (typeof r.paused === 'boolean') applyServerPaused(r.paused);
            setState((prev) => ({ ...prev, ms: r.ms! + pendingRef.current }));
          }
        },
      );
    };

    const tick = window.setInterval(() => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      // Wall-clock cadence, independent of accrual — the keepalive must
      // keep the session's heartbeat fresh even while nothing counts.
      sinceFlush += delta;
      // Scoped to the active player (watch or Shorts) — hovering a
      // homepage preview video must not count.
      const video = ytVideoEl();
      const playing = !!video && !video.paused && !video.ended;
      // The state we report to the desktop: "is watch time accruing"
      // (before the desktop-pause gate — that gate is the desktop's
      // own doing and needs no echo).
      const accruing = countableRef.current && (playing || countWhilePausedRef.current);
      let edge = accrualEdge(lastAccrualRef.current, accruing);
      lastAccrualRef.current = accruing;
      // Pressing play while the desktop has us paused is an explicit
      // resume intent, even when count-while-paused kept the accrual
      // state nominally unchanged.
      if (sessionPausedRef.current && playing && lastRawPlayingRef.current === false) {
        edge = true;
      }
      lastRawPlayingRef.current = playing;
      if (accruing && !sessionPausedRef.current) {
        pendingRef.current += delta;
        ctxRef.current = { title: pageTitle(), url: window.location.href, ...playbackInfo() };
        setState((prev) => ({ ...prev, ms: prev.ms + delta }));
      }
      if (edge != null) {
        sinceFlush = 0;
        flush(true, edge);
      } else if (sinceFlush >= BEAT_FLUSH_MS) {
        sinceFlush = 0;
        flush(true);
      }
    }, 1000);

    // Don't lose the tail when the tab is closed / backgrounded.
    const onHide = () => flush();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [enabled, state.active]);

  // ~3 s control poll while active: picks up desktop-issued commands.
  // The background answers from local state when no desktop row is
  // live, so this stays cheap for unpaired setups.
  useEffect(() => {
    if (!enabled || !state.active) return;

    const remoteStop = () => {
      const tail = pendingRef.current;
      pendingRef.current = 0;
      const ctx = tail > 0 ? ctxRef.current : null;
      sendMsg({ action: 'immersionStop', deltaMs: tail, ...(ctx ?? {}) }, () => {});
      resetSessionRefs();
      setState({ active: false, ms: 0, paused: false });
      onRemoteEndRef.current?.();
    };

    const poll = window.setInterval(() => {
      sendMsg({ action: 'immersionControlPoll' }, (res) => {
        const r = res as unknown as
          | {
              success?: boolean;
              active?: boolean;
              paused?: boolean;
              control?: 'pause' | 'resume' | null;
              endRequested?: boolean;
            }
          | undefined;
        if (!r?.success) return;
        if (r.active === false) {
          resetSessionRefs();
          setState({ active: false, ms: 0, paused: false });
          onRemoteEndRef.current?.();
          return;
        }
        if (r.endRequested) {
          // Desktop End — close out through the normal stop path so
          // the tail seconds + final position aren't lost.
          remoteStop();
          return;
        }
        if (typeof r.paused === 'boolean') applyServerPaused(r.paused);
        // Video-level effect of a desktop command. The session-level
        // state was already applied by the background; play() may be
        // rejected by autoplay policy in a background tab — the
        // session still resumes, counting whenever playback does.
        const video = ytVideoEl();
        if (r.control === 'pause') video?.pause();
        else if (r.control === 'resume' && video?.paused) {
          void video.play().catch(() => {});
        }
      });
    }, CONTROL_POLL_MS);
    return () => window.clearInterval(poll);
  }, [enabled, state.active]);

  const toggle = () => {
    if (state.active) {
      const tail = pendingRef.current;
      pendingRef.current = 0;
      const ctx = tail > 0 ? ctxRef.current : null;
      sendMsg(
        {
          action: 'immersionStop',
          deltaMs: tail,
          ...(ctx ?? {}),
        },
        () => {},
      );
      resetSessionRefs();
      setState({ active: false, ms: 0, paused: false });
    } else {
      refreshPauseSetting();
      resetSessionRefs();
      sendMsg(
        { action: 'immersionStart', title: pageTitle(), url: window.location.href },
        (res) => {
          const r = res as unknown as { success?: boolean; ms?: number } | undefined;
          if (r?.success) setState({ active: true, ms: r.ms || 0, paused: false });
        },
      );
    }
  };

  return { active: state.active, ms: state.ms, paused: state.paused, toggle };
}

function pageTitle(): string {
  return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
}

/** Current playback position/length of the real watch-page player.
 *  Empty when there's no player (channel pages etc.) — the beat then
 *  carries time only. */
function playbackInfo(): { positionSec?: number; durationSec?: number; ended?: boolean } {
  const video = ytVideoEl();
  if (!video) return {};
  return {
    positionSec: Math.round(video.currentTime) || undefined,
    durationSec: Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
    ended: video.ended || undefined,
  };
}
