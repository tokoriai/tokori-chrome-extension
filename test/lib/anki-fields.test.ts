import { describe, it, expect } from 'vitest';
import { mimeToExt, buildAnkiFields } from '@/lib/anki-fields';

describe('mimeToExt', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['video/webm', 'webm'],
    ['video/mp4', 'mp4'],
    ['audio/mpeg', 'mp3'],
    ['audio/ogg', 'ogg'],
  ])('maps %s to %s', (mime, ext) => {
    expect(mimeToExt(mime, 'bin')).toBe(ext);
  });

  it('is case-insensitive', () => {
    expect(mimeToExt('IMAGE/JPEG', 'bin')).toBe('jpg');
  });

  it('returns the fallback for undefined', () => {
    expect(mimeToExt(undefined, 'jpg')).toBe('jpg');
  });

  it('returns the fallback for an unknown type', () => {
    expect(mimeToExt('application/x-foo', 'webm')).toBe('webm');
  });
});

describe('buildAnkiFields', () => {
  it('maps marker values onto the configured field names', () => {
    expect(
      buildAnkiFields({ Front: 'word', Back: 'definition' }, { word: '你', definition: 'you' }),
    ).toEqual({
      Front: '你',
      Back: 'you',
    });
  });

  it('fills unmapped markers with an empty string', () => {
    expect(buildAnkiFields({ Front: 'reading' }, {})).toEqual({ Front: '' });
  });

  it('returns an empty object for an empty field map', () => {
    expect(buildAnkiFields({}, { word: 'x' })).toEqual({});
  });
});
