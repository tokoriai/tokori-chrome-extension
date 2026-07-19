import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isShortsPage,
  ytPageVideoId,
  ytPlayerEl,
  ytPlayerId,
  ytVideoEl,
  ytVideoSelector,
} from '@/content/youtube/player-el';

/** Minimal stand-ins for the two page shapes: SPA navigation keeps the
 *  OTHER surface's player in the DOM, so both ids often exist at once. */
function stubPage(path: string, search = '', players: Record<string, { video?: boolean }> = {}) {
  vi.stubGlobal('window', { location: { pathname: path, search } });
  const els: Record<string, unknown> = {};
  for (const [id, cfg] of Object.entries(players)) {
    els[id] = {
      id,
      querySelector: (sel: string) => (sel === 'video' && cfg.video ? { id: `${id}-video` } : null),
    };
  }
  vi.stubGlobal('document', {
    getElementById: (id: string) => (els[id] as HTMLElement | undefined) ?? null,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ytPageVideoId', () => {
  it('reads ?v= on watch pages', () => {
    stubPage('/watch', '?v=abc123DEF45&t=10s');
    expect(ytPageVideoId()).toBe('abc123DEF45');
  });

  it('reads the path id on /shorts/ pages', () => {
    stubPage('/shorts/xYz-_987654');
    expect(ytPageVideoId()).toBe('xYz-_987654');
  });

  it('reads the path id on /live/ pages', () => {
    stubPage('/live/liveId12345');
    expect(ytPageVideoId()).toBe('liveId12345');
  });

  it('is empty off player pages', () => {
    stubPage('/feed/subscriptions');
    expect(ytPageVideoId()).toBe('');
  });
});

describe('player element scoping', () => {
  it('targets #movie_player on watch pages', () => {
    stubPage('/watch', '?v=abc123DEF45');
    expect(ytPlayerId()).toBe('movie_player');
    expect(ytVideoSelector()).toBe('#movie_player video');
    expect(isShortsPage()).toBe(false);
  });

  it('targets #shorts-player on Shorts pages', () => {
    stubPage('/shorts/xYz-_987654');
    expect(ytPlayerId()).toBe('shorts-player');
    expect(ytVideoSelector()).toBe('#shorts-player video');
    expect(isShortsPage()).toBe(true);
  });

  it('picks the Shorts player even when a leftover watch player exists', () => {
    stubPage('/shorts/xYz-_987654', '', {
      movie_player: { video: true },
      'shorts-player': { video: true },
    });
    expect((ytPlayerEl() as unknown as { id: string }).id).toBe('shorts-player');
    expect((ytVideoEl() as unknown as { id: string }).id).toBe('shorts-player-video');
  });

  it('picks the watch player even when a leftover Shorts player exists', () => {
    stubPage('/watch', '?v=abc123DEF45', {
      movie_player: { video: true },
      'shorts-player': { video: true },
    });
    expect((ytPlayerEl() as unknown as { id: string }).id).toBe('movie_player');
    expect((ytVideoEl() as unknown as { id: string }).id).toBe('movie_player-video');
  });

  it('returns null video when the active player is missing', () => {
    stubPage('/shorts/xYz-_987654', '', { movie_player: { video: true } });
    expect(ytPlayerEl()).toBeNull();
    expect(ytVideoEl()).toBeNull();
  });
});
