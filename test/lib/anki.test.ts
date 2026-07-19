import { describe, it, expect } from 'vitest';
import { stripDataUrl, makeMediaFilename } from '@/lib/anki';

describe('stripDataUrl', () => {
  it('strips the data: prefix and returns the base64 payload', () => {
    expect(stripDataUrl('data:image/jpeg;base64,AAAA')).toBe('AAAA');
  });

  it('survives MIME codec params whose comma precedes the payload', () => {
    // MediaRecorder clips: the naive first-comma cut shipped
    // "opus;base64,GkXf…" and the desktop rejected the audio_data.
    expect(stripDataUrl('data:video/webm;codecs=vp9,opus;base64,GkXf')).toBe('GkXf');
  });

  it('returns the input unchanged when there is no comma', () => {
    expect(stripDataUrl('AAAA')).toBe('AAAA');
  });

  it('returns an empty string for an empty payload', () => {
    expect(stripDataUrl('data:,')).toBe('');
  });
});

describe('makeMediaFilename', () => {
  it('builds a prefixed, timestamped filename and preserves CJK', () => {
    expect(makeMediaFilename('img', 'zh', '你好', 'jpg')).toMatch(/^tokori-img-zh-你好-\d+\.jpg$/);
  });

  it('falls back to "card" for an empty word', () => {
    expect(makeMediaFilename('clip', 'ja', '', 'webm')).toMatch(/^tokori-clip-ja-card-\d+\.webm$/);
  });

  it('collapses spaces and punctuation into underscores', () => {
    expect(makeMediaFilename('img', 'en', 'a b/c', 'png')).toMatch(
      /^tokori-img-en-a_b_c-\d+\.png$/,
    );
  });

  it('truncates long words to 32 characters', () => {
    expect(makeMediaFilename('img', 'en', 'a'.repeat(40), 'jpg')).toMatch(
      /^tokori-img-en-a{32}-\d+\.jpg$/,
    );
  });
});
