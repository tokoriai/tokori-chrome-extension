import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scaleToFit, pickClipMime } from '@/lib/mining/capture';

describe('scaleToFit', () => {
  it('downscales a landscape source by its longest edge', () => {
    expect(scaleToFit(1920, 1080, 640)).toEqual({ w: 640, h: 360, scale: 640 / 1920 });
  });

  it('downscales a portrait source by its longest edge', () => {
    expect(scaleToFit(1080, 1920, 640)).toEqual({ w: 360, h: 640, scale: 640 / 1920 });
  });

  it('never upscales a source already under budget', () => {
    expect(scaleToFit(320, 240, 640)).toEqual({ w: 320, h: 240, scale: 1 });
  });

  it('rounds to whole pixels', () => {
    expect(scaleToFit(1000, 1000, 640)).toEqual({ w: 640, h: 640, scale: 0.64 });
  });
});

describe('pickClipMime', () => {
  beforeEach(() => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = { isTypeSupported: vi.fn() };
  });

  function isTypeSupported() {
    return (
      globalThis as unknown as { MediaRecorder: { isTypeSupported: ReturnType<typeof vi.fn> } }
    ).MediaRecorder.isTypeSupported;
  }

  it('returns the preferred type when supported', () => {
    isTypeSupported().mockReturnValue(true);
    expect(pickClipMime('video/webm;codecs=av1')).toBe('video/webm;codecs=av1');
  });

  it('falls back to the first supported codec', () => {
    isTypeSupported().mockImplementation((t: string) => t === 'video/webm;codecs=vp9,opus');
    expect(pickClipMime()).toBe('video/webm;codecs=vp9,opus');
  });

  it('returns generic video/webm when nothing reports support', () => {
    isTypeSupported().mockReturnValue(false);
    expect(pickClipMime()).toBe('video/webm');
  });
});
