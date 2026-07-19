import { describe, it, expect } from 'vitest';
import {
  isMasterWithSubtitles,
  parseM3u8Attrs,
  parseMasterSubtitles,
  parseMediaSegments,
} from '@/lib/m3u8';

const BASE = 'https://cdn.example.com/title/123/master.m3u8?token=abc';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English [CC]",LANGUAGE="en",AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog",URI="subs/en/playlist.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="简体中文",LANGUAGE="zh-Hans",URI="subs/zh-hans/playlist.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Español",LANGUAGE="es-419",FORCED=YES,URI="subs/es-f/playlist.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Deutsch",LANGUAGE="de",CHARACTERISTICS="public.accessibility.describes-music-and-sound",URI="subs/de/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="sub"
video/main.m3u8
`;

describe('isMasterWithSubtitles', () => {
  it('accepts a master with subtitle renditions, rejects everything else', () => {
    expect(isMasterWithSubtitles(MASTER)).toBe(true);
    expect(isMasterWithSubtitles('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.vtt')).toBe(false);
    expect(isMasterWithSubtitles('{"json":true}')).toBe(false);
  });
});

describe('parseM3u8Attrs', () => {
  it('parses quoted values containing commas and bare values', () => {
    const attrs = parseM3u8Attrs(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English, please [CC]",FORCED=NO,URI="a/b.m3u8"',
    );
    expect(attrs['TYPE']).toBe('SUBTITLES');
    expect(attrs['NAME']).toBe('English, please [CC]');
    expect(attrs['FORCED']).toBe('NO');
    expect(attrs['URI']).toBe('a/b.m3u8');
  });
});

describe('parseMasterSubtitles', () => {
  const tracks = parseMasterSubtitles(MASTER, BASE);

  it('extracts subtitle renditions only, with resolved URLs', () => {
    expect(tracks.map((t) => t.language)).toEqual(['en', 'zh-Hans', 'es-419', 'de']);
    expect(tracks[0]!.url).toBe('https://cdn.example.com/title/123/subs/en/playlist.m3u8');
  });

  it('flags forced narrative tracks so callers can skip them', () => {
    expect(tracks.find((t) => t.language === 'es-419')!.forced).toBe(true);
    expect(tracks.find((t) => t.language === 'zh-Hans')!.forced).toBe(false);
  });

  it('appends (CC) for accessibility tracks unless the name already says so', () => {
    expect(tracks.find((t) => t.language === 'de')!.label).toBe('Deutsch (CC)');
    // Name already carries [CC] — no doubling.
    expect(tracks.find((t) => t.language === 'en')!.label).toBe('English [CC]');
  });
});

describe('parseMediaSegments', () => {
  it('resolves every non-comment line against the playlist URL', () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:60
#EXTINF:60.0,
seg_1.vtt
#EXTINF:60.0,
seg_2.vtt

#EXT-X-ENDLIST
`;
    expect(parseMediaSegments(playlist, 'https://cdn.example.com/subs/zh/playlist.m3u8')).toEqual([
      'https://cdn.example.com/subs/zh/seg_1.vtt',
      'https://cdn.example.com/subs/zh/seg_2.vtt',
    ]);
  });
});
