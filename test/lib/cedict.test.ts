import { describe, it, expect } from 'vitest';
import { parseCedictLines, syllableToMarks } from '@/lib/dictionaries/cedict';

describe('syllableToMarks', () => {
  it.each([
    ['hao3', 'hǎo'],
    ['ni3', 'nǐ'],
    ['ma4', 'mà'],
    ['de5', 'de'],
    ['gou3', 'gǒu'],
    ['de', 'de'],
    // ü handling: tone mark on the ü itself…
    ['nu:3', 'nǚ'],
    ['lu:4', 'lǜ'],
    // …tone mark on a following vowel (略/虐-type syllables)…
    ['lu:e4', 'lüè'],
    ['nu:e4', 'nüè'],
    // …and neutral tone must still render ü, not a literal v.
    ['nu:5', 'nü'],
    // Some sources write neutral tone as 0 instead of 5.
    ['ma0', 'ma'],
    // Standard mark-placement rules: iu → mark u, ui → mark i.
    ['liu4', 'liù'],
    ['gui4', 'guì'],
    ['xiao3', 'xiǎo'],
  ])('converts %s to %s', (input, expected) => {
    expect(syllableToMarks(input)).toBe(expected);
  });
});

describe('parseCedictLines', () => {
  const text = [
    '# CC-CEDICT comment line',
    '',
    '你好 你好 [ni3 hao3] /hello/hi/',
    '漢字 汉字 [han4 zi4] /Chinese character/',
    'garbage with no brackets',
    '试 试 [shi4] /a//b/',
  ].join('\n');

  const { bySurface, byReading, matched, skipped } = parseCedictLines(text);

  it('counts matched and skipped lines (comments/blanks are neither)', () => {
    expect(matched).toBe(3);
    expect(skipped).toBe(1);
  });

  it('keys entries by surface form with diacritic pinyin and split glosses', () => {
    const entry = bySurface.get('你好')?.[0];
    expect(entry).toMatchObject({
      word: '你好',
      reading: 'nǐ hǎo',
      definitions: ['hello', 'hi'],
    });
  });

  it('links traditional and simplified to the same simplified-keyed entry', () => {
    expect(bySurface.get('漢字')?.[0].word).toBe('汉字');
    expect(bySurface.get('汉字')?.[0].word).toBe('汉字');
  });

  it('filters empty glosses from runs of slashes', () => {
    expect(bySurface.get('试')?.[0].definitions).toEqual(['a', 'b']);
  });

  it('indexes by stripped (toneless, spaceless) pinyin', () => {
    expect(byReading.get('nihao')?.[0].word).toBe('你好');
  });

  it('skips comments and blank lines', () => {
    expect(bySurface.has('#')).toBe(false);
    expect(bySurface.size).toBe(4); // 你好, 汉字, 漢字, 试
  });
});
