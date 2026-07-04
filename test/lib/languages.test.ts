import { describe, it, expect } from 'vitest';
import { detectLanguage, getLanguage } from '@/lib/languages';

describe('detectLanguage', () => {
  it('detects Chinese from Han characters', () => {
    expect(detectLanguage('你好世界')).toBe('zh');
  });

  it('detects Japanese when kana is present', () => {
    expect(detectLanguage('これは日本語です')).toBe('ja');
  });

  it('prefers Japanese for mixed kanji + kana', () => {
    expect(detectLanguage('漢字とかな')).toBe('ja');
  });

  it('detects Korean (Hangul)', () => {
    expect(detectLanguage('안녕하세요')).toBe('ko');
  });

  it('detects Arabic', () => {
    expect(detectLanguage('مرحبا')).toBe('ar');
  });

  it('detects Russian (Cyrillic)', () => {
    expect(detectLanguage('Привет')).toBe('ru');
  });

  it('detects Hindi (Devanagari)', () => {
    expect(detectLanguage('नमस्ते')).toBe('hi');
  });

  it('detects Thai', () => {
    expect(detectLanguage('สวัสดี')).toBe('th');
  });

  it('returns null for Latin script', () => {
    expect(detectLanguage('Bonjour')).toBeNull();
    expect(detectLanguage('Hello')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectLanguage('')).toBeNull();
  });

  it('returns null for numbers and punctuation only', () => {
    expect(detectLanguage('123 !?.,')).toBeNull();
  });

  it('detects Han even when mixed with Latin', () => {
    expect(detectLanguage('Hello 你好')).toBe('zh');
  });
});

describe('getLanguage', () => {
  it('returns the profile for a known code', () => {
    const zh = getLanguage('zh');
    expect(zh).toBeDefined();
    expect(zh?.tokenizer).toBe('jieba');
    expect(zh?.hasReading).toBe(true);
    expect(zh?.recommendedDict).toBe('cc-cedict');
  });

  it('returns undefined for an unknown code', () => {
    expect(getLanguage('xx')).toBeUndefined();
  });
});
