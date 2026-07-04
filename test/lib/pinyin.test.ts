import { describe, it, expect } from 'vitest';
import { parsePinyin, prettyPinyin, splitPinyinSyllables } from '@/lib/pinyin';

describe('splitPinyinSyllables', () => {
  it('passes through space-separated readings one chunk per syllable', () => {
    expect(splitPinyinSyllables('ni3 hao3')).toEqual(['ni3', 'hao3']);
    expect(splitPinyinSyllables('chéng dū')).toEqual(['chéng', 'dū']);
  });

  it('splits on apostrophes and middle dots', () => {
    expect(splitPinyinSyllables("Xī'ān")).toEqual(['Xī', 'ān']);
    expect(splitPinyinSyllables('bù·kěsīyì').length).toBeGreaterThan(1);
  });

  it('syllabifies spaceless tone-marked runs', () => {
    expect(splitPinyinSyllables('Zhōngguó')).toEqual(['Zhōng', 'guó']);
    expect(splitPinyinSyllables('nǐhǎo')).toEqual(['nǐ', 'hǎo']);
  });

  it('syllabifies spaceless numeric runs', () => {
    expect(splitPinyinSyllables('ce4shi4')).toEqual(['ce4', 'shi4']);
  });

  it('prefers the longest syllable ("xian" stays whole)', () => {
    expect(splitPinyinSyllables('xiān')).toEqual(['xiān']);
  });

  it('backtracks when the greedy split dead-ends', () => {
    // "fānguǎn": greedy "fāng" leaves "uǎn" (invalid) → recovers fān+guǎn.
    expect(splitPinyinSyllables('fānguǎn')).toEqual(['fān', 'guǎn']);
  });

  it('leaves non-pinyin chunks untouched', () => {
    expect(splitPinyinSyllables('たべる')).toEqual(['たべる']);
  });
});

describe('parsePinyin', () => {
  it('converts CC-CEDICT numeric tones to diacritics', () => {
    expect(parsePinyin('ni3 hao3')).toEqual([
      { pretty: 'nǐ', tone: 3 },
      { pretty: 'hǎo', tone: 3 },
    ]);
  });

  it('detects tones from existing diacritics', () => {
    expect(parsePinyin('chéng dū')).toEqual([
      { pretty: 'chéng', tone: 2 },
      { pretty: 'dū', tone: 1 },
    ]);
  });

  it('handles ü spellings (u: and v)', () => {
    expect(parsePinyin('nu:3')).toEqual([{ pretty: 'nǚ', tone: 3 }]);
    expect(parsePinyin('lv4')).toEqual([{ pretty: 'lǜ', tone: 4 }]);
  });

  it('treats unmarked syllables as neutral tone', () => {
    expect(parsePinyin('de')).toEqual([{ pretty: 'de', tone: 5 }]);
  });

  it('handles the empty / missing reading', () => {
    expect(parsePinyin('')).toEqual([]);
    expect(parsePinyin(null)).toEqual([]);
    expect(parsePinyin(undefined)).toEqual([]);
  });

  it('aligns one syllable per hanzi for typical dictionary readings', () => {
    // The RubyWord component relies on this count matching Array.from(word).
    expect(parsePinyin('Zhōngguó')).toHaveLength(2);
    expect(parsePinyin('xiǎo bèi bei')).toHaveLength(3);
  });
});

describe('prettyPinyin', () => {
  it('joins prettified syllables with spaces', () => {
    expect(prettyPinyin('ni3 hao3')).toBe('nǐ hǎo');
    expect(prettyPinyin('Zhōngguó')).toBe('Zhōng guó');
  });
});
