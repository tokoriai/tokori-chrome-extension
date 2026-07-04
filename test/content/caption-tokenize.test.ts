import { describe, it, expect } from 'vitest';
import { tokenize, packTokens } from '@/content/youtube/caption-tokenize';

describe('tokenize', () => {
  it('emits one token per CJK character', () => {
    expect(tokenize('你好')).toEqual([
      { kind: 'word', text: '你' },
      { kind: 'word', text: '好' },
    ]);
  });

  it('keeps Latin words whole and spaces as separate tokens', () => {
    expect(tokenize('hello world')).toEqual([
      { kind: 'word', text: 'hello' },
      { kind: 'space', text: ' ' },
      { kind: 'word', text: 'world' },
    ]);
  });

  it('classifies punctuation as a space token', () => {
    expect(tokenize('Hi!')).toEqual([
      { kind: 'word', text: 'Hi' },
      { kind: 'space', text: '!' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('reconstructs the original string from token text', () => {
    const input = '你好, world！';
    expect(
      tokenize(input)
        .map((t) => t.text)
        .join(''),
    ).toBe(input);
  });
});

describe('packTokens', () => {
  it('marks whitespace and short punctuation as space tokens', () => {
    expect(packTokens(['hello', ' ', '。'])).toEqual([
      { kind: 'word', text: 'hello' },
      { kind: 'space', text: ' ' },
      { kind: 'space', text: '。' },
    ]);
  });

  it('treats multi-character segments as words', () => {
    expect(packTokens(['你好', '世界'])).toEqual([
      { kind: 'word', text: '你好' },
      { kind: 'word', text: '世界' },
    ]);
  });

  it('skips empty strings', () => {
    expect(packTokens(['a', '', 'b'])).toEqual([
      { kind: 'word', text: 'a' },
      { kind: 'word', text: 'b' },
    ]);
  });
});
