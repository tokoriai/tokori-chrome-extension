import { describe, it, expect } from 'vitest';
import { tokenise } from '@/content/sentence-tokens';
import type { LanguageCode } from '@/lib/languages';

describe('tokenise', () => {
  it('segments Chinese into word-like tokens that reconstruct the input', () => {
    const tokens = tokenise('你好世界', 'zh');
    expect(tokens.some((t) => t.word)).toBe(true);
    expect(tokens.map((t) => t.text).join('')).toBe('你好世界');
  });

  it('marks spaces as non-words in Latin text', () => {
    const tokens = tokenise('Hello world', 'en' as LanguageCode);
    expect(tokens.map((t) => t.text).join('')).toBe('Hello world');
    const space = tokens.find((t) => t.text === ' ');
    expect(space?.word).toBe(false);
  });

  it('marks punctuation as a non-word', () => {
    const tokens = tokenise('Hi!', 'en' as LanguageCode);
    expect(tokens.find((t) => t.text === '!')?.word).toBe(false);
  });

  it('handles a null language by defaulting to the en locale', () => {
    const tokens = tokenise('Hello world', null);
    expect(tokens.map((t) => t.text).join('')).toBe('Hello world');
  });

  it('falls back to the en locale for an unknown language code', () => {
    const tokens = tokenise('Hello', 'xx' as LanguageCode);
    expect(tokens.some((t) => t.word)).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenise('', 'en' as LanguageCode)).toEqual([]);
  });
});
