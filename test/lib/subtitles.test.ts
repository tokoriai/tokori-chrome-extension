import { describe, expect, it } from 'vitest';
import { cueAt, mergeSegmentCues, parseSubtitles, type SubtitleCue } from '@/lib/subtitles';

describe('parseSubtitles', () => {
  it('parses SRT with comma milliseconds and indexes', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,500',
      '你好世界',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,000',
      'Second line',
      'continues here',
    ].join('\n');
    const cues = parseSubtitles(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, dur: 2.5, text: '你好世界' });
    expect(cues[1]!.text).toBe('Second line\ncontinues here');
  });

  it('parses WebVTT with header, ids, settings, and dot milliseconds', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this block is ignored',
      '',
      'intro',
      '00:01.000 --> 00:02.000 align:start position:10%',
      '<c.yellow>styled</c> <i>text</i>',
      '',
      '01:00:00.000 --> 01:00:05.000',
      'hour mark',
    ].join('\n');
    const cues = parseSubtitles(vtt);
    expect(cues).toHaveLength(2);
    // WebVTT short form is mm:ss.ttt — "00:01.000" is one second in.
    expect(cues[0]).toEqual({ start: 1, dur: 1, text: 'styled text' });
    expect(cues[1]!.start).toBe(3600);
  });

  it('survives CRLF, BOM, ASS override tags, and junk blocks', () => {
    const messy =
      '﻿1\r\n00:00:00,500 --> 00:00:01,000\r\n{\\an8}Top text\r\n\r\nnot a cue at all\r\n\r\n2\r\n00:00:02,000 --> 00:00:01,000\r\nnegative duration dropped';
    const cues = parseSubtitles(messy);
    expect(cues).toEqual([{ start: 0.5, dur: 0.5, text: 'Top text' }]);
  });
});

describe('cueAt', () => {
  const cues = parseSubtitles(
    '1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:03,000 --> 00:00:04,000\nb',
  );
  it('finds the covering cue and respects gaps', () => {
    expect(cueAt(cues, 1.5)?.text).toBe('a');
    expect(cueAt(cues, 2.5)).toBeNull();
    expect(cueAt(cues, 3.0)?.text).toBe('b');
    expect(cueAt(cues, 10)).toBeNull();
  });
});

describe('mergeSegmentCues', () => {
  const c = (start: number, dur: number, text: string): SubtitleCue => ({ start, dur, text });

  it('drops exact duplicates repeated across segment boundaries and sorts', () => {
    const segA = [c(58, 4, '跨段的句子'), c(50, 2, 'earlier')];
    const segB = [c(58, 4, '跨段的句子'), c(63, 2, 'later')];
    expect(mergeSegmentCues([segA, segB])).toEqual([
      c(50, 2, 'earlier'),
      c(58, 4, '跨段的句子'),
      c(63, 2, 'later'),
    ]);
  });

  it('coalesces the same text split across a boundary with shifted windows', () => {
    // Segment 1 shows the cue until its end; segment 2 re-declares the
    // remainder — one logical cue, two records.
    const merged = mergeSegmentCues([[c(58, 2, '一句话')], [c(60, 3, '一句话')]]);
    expect(merged).toEqual([c(58, 5, '一句话')]);
  });

  it('keeps identical text apart when the gap is real (repeated dialogue)', () => {
    const merged = mergeSegmentCues([[c(10, 2, '喂？'), c(20, 2, '喂？')]]);
    expect(merged).toHaveLength(2);
  });

  it('never mutates its inputs', () => {
    const seg = [c(1, 5, 'x')];
    mergeSegmentCues([seg, [c(5.5, 2, 'x')]]);
    expect(seg[0]).toEqual(c(1, 5, 'x'));
  });
});
