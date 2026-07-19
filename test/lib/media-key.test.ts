import { describe, expect, it } from 'vitest';
import { canonicalMediaKey, urlWithResume, ytThumbnail, ytVideoId } from '@/lib/media-key';

describe('ytVideoId', () => {
  it('extracts the id from the common URL spellings', () => {
    expect(ytVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(ytVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    expect(ytVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx')).toBe('dQw4w9WgXcQ');
    expect(ytVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ/')).toBe('dQw4w9WgXcQ');
    expect(ytVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('rejects non-video pages and junk', () => {
    expect(ytVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(ytVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(ytVideoId('not a url')).toBeNull();
  });
});

describe('canonicalMediaKey', () => {
  // Grammar-compatibility vectors — must match the Tokori app's
  // src/lib/media/url.ts (and the desktop's Rust twin), or keys minted
  // in the browser store stop comparing equal to desktop-derived ones.
  it('mints keys the desktop derives for the same URLs', () => {
    expect(canonicalMediaKey('https://youtu.be/dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
    expect(canonicalMediaKey('youtube.com/shorts/dQw4w9WgXcQ/')).toBe('yt:dQw4w9WgXcQ');
    expect(canonicalMediaKey('https://www.youtube.com/playlist?list=PLabcDEF123')).toBe(
      'yt:pl:PLabcDEF123',
    );
    expect(canonicalMediaKey('https://example.com/shows/my-show/')).toBe(
      'web:example.com/shows/my-show',
    );
    expect(canonicalMediaKey('mailto:x@y.example')).toBeNull();
  });
});

describe('ytThumbnail', () => {
  it('builds the mqdefault URL for videos only', () => {
    expect(ytThumbnail('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
    );
    expect(ytThumbnail('https://example.com/a')).toBeNull();
  });
});

describe('urlWithResume', () => {
  it('decorates YouTube links with a resume timestamp past 30s', () => {
    expect(urlWithResume('https://youtu.be/dQw4w9WgXcQ', 95)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s',
    );
  });

  it('leaves early positions and non-YouTube URLs alone', () => {
    expect(urlWithResume('https://youtu.be/dQw4w9WgXcQ', 10)).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(urlWithResume('https://youtu.be/dQw4w9WgXcQ', null)).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
    expect(urlWithResume('https://example.com/a', 500)).toBe('https://example.com/a');
  });
});
