import { describe, it, expect } from 'vitest';
import {
  applyOcrSample,
  cleanOcrTextForLang,
  extractSubtitlePixels,
  keepOcrText,
  normalizeOcrText,
  normalizeOcrRegion,
  ocrTextSimilarity,
  tesseractLangFor,
  DEFAULT_OCR_REGION,
  OCR_OPEN_DUR,
  type OcrCue,
} from '@/lib/ocr-cues';

const open = (start: number, text: string): OcrCue => ({ start, dur: OCR_OPEN_DUR, text });

describe('normalizeOcrText', () => {
  it('collapses whitespace and newlines from two-line subtitles', () => {
    expect(normalizeOcrText('  你好\n 世界  ')).toBe('你好 世界');
    expect(normalizeOcrText('\n')).toBe('');
  });
});

describe('tesseractLangFor', () => {
  it('maps supported codes and rejects unknown ones', () => {
    expect(tesseractLangFor('zh')).toBe('chi_sim');
    expect(tesseractLangFor('ja')).toBe('jpn');
    expect(tesseractLangFor('en')).toBe('eng');
    expect(tesseractLangFor('tlh')).toBeNull();
    expect(tesseractLangFor(null)).toBeNull();
  });
});

describe('cleanOcrTextForLang', () => {
  it('collapses tesseract’s spurious gaps between CJK glyphs', () => {
    expect(cleanOcrTextForLang('你 好 世 界', 'chi_sim')).toBe('你好世界');
    expect(cleanOcrTextForLang('今日 は いい 天気', 'jpn')).toBe('今日はいい天気');
  });

  it('keeps real spaces around Latin words inside CJK lines', () => {
    expect(cleanOcrTextForLang('我 用 iPhone 学习', 'chi_sim')).toBe('我用 iPhone 学习');
  });

  it('leaves Latin packs at plain whitespace normalization', () => {
    expect(cleanOcrTextForLang('hello   world\n', 'eng')).toBe('hello world');
  });

  it('drops vertical-edge "|" artifacts for CJK packs only', () => {
    // Scene edges (door frames, poles) that survive pixel extraction
    // decode as bars — no CJK subtitle uses them.
    expect(cleanOcrTextForLang('| 你好 世界 | |', 'chi_sim')).toBe('你好世界');
    expect(cleanOcrTextForLang('｜こんにちは｜', 'jpn')).toBe('こんにちは');
    // On Latin packs a bar could be an l/I misread — leave it alone.
    expect(cleanOcrTextForLang('a | b', 'eng')).toBe('a | b');
  });
});

describe('extractSubtitlePixels', () => {
  /** Grayscale RGBA crop from a per-pixel luma function. */
  const crop = (w: number, h: number, lumaAt: (x: number, y: number) => number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        px[o] = px[o + 1] = px[o + 2] = lumaAt(x, y);
        px[o + 3] = 255;
      }
    }
    return px;
  };
  const at = (px: Uint8ClampedArray, w: number, x: number, y: number) => px[(y * w + x) * 4];
  const rect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;

  it('keeps outlined text and drops bright scenery around it', () => {
    const W = 24;
    const H = 16;
    // White fill block wrapped in a dark outline, floating on a bright
    // (sky-like) background.
    const px = crop(W, H, (x, y) =>
      rect(x, y, 9, 5, 14, 10) ? 255 : rect(x, y, 8, 4, 15, 11) ? 30 : 200,
    );
    extractSubtitlePixels(px, W, H);
    expect(at(px, W, 11, 7)).toBe(0); // fill → ink
    expect(at(px, W, 2, 2)).toBe(255); // far scene → page
    expect(at(px, W, 7, 7)).toBe(255); // halo hugging the outline → page
    expect(at(px, W, 8, 7)).toBe(255); // the outline itself → page
  });

  it('drops a uniformly bright scene with no text at all', () => {
    const W = 20;
    const H = 12;
    const px = crop(W, H, () => 210);
    extractSubtitlePixels(px, W, H);
    for (let x = 0; x < W; x++) expect(at(px, W, x, 6)).toBe(255);
  });

  it('degrades to the plain threshold on a dark scene', () => {
    const W = 24;
    const H = 16;
    // Outline-less white block on a dark backdrop — the classic case
    // the original binarizer handled.
    const px = crop(W, H, (x, y) => (rect(x, y, 8, 5, 15, 10) ? 255 : 20));
    extractSubtitlePixels(px, W, H);
    expect(at(px, W, 11, 7)).toBe(0);
    expect(at(px, W, 2, 2)).toBe(255);
  });

  it('falls back to the plain threshold for outline-less text on mid-gray', () => {
    const W = 24;
    const H = 16;
    const px = crop(W, H, (x, y) => (rect(x, y, 8, 5, 15, 10) ? 255 : 140));
    extractSubtitlePixels(px, W, H);
    expect(at(px, W, 11, 7)).toBe(0);
    expect(at(px, W, 2, 2)).toBe(255);
  });

  it('removes isolated bright specks', () => {
    const W = 24;
    const H = 16;
    // A real block plus one lone bright pixel far from it, on dark.
    const px = crop(W, H, (x, y) => (rect(x, y, 8, 5, 15, 10) || (x === 2 && y === 2) ? 255 : 20));
    extractSubtitlePixels(px, W, H);
    expect(at(px, W, 11, 7)).toBe(0);
    expect(at(px, W, 2, 2)).toBe(255); // speck gone
  });
});

describe('keepOcrText', () => {
  // The regression that made CJK OCR sit at "watching…" forever:
  // tesseract.js v7 returns confidence=0 for a clean read, and the old
  // gate dropped anything under the floor — i.e. everything.
  it('keeps a real CJK read reported at confidence 0 (the v7 quirk)', () => {
    expect(keepOcrText('和二', 0, 'chi_sim')).toBe('和二');
    expect(keepOcrText('こんにちは', 0, 'jpn')).toBe('こんにちは');
    expect(keepOcrText('안녕하세요', 0, 'kor')).toBe('안녕하세요');
  });

  it('ignores confidence for CJK (unreliable in v7) — keeps at any score', () => {
    // The exact case from the field log: conf reported low/zero for a
    // correct read. CJK is gated on glyph content, not the number.
    expect(keepOcrText('和二', 10, 'chi_sim')).toBe('和二');
    expect(keepOcrText('和二', 0, 'chi_sim')).toBe('和二');
    expect(keepOcrText('和二', 90, 'chi_sim')).toBe('和二');
  });

  it('drops a Latin read with a POSITIVE confidence below the floor', () => {
    expect(keepOcrText('hello', 20, 'eng')).toBe(''); // < 35 Latin floor
    expect(keepOcrText('hello', 60, 'eng')).toBe('hello');
  });

  it('rejects glyph-less junk on CJK packs when confidence is unavailable', () => {
    // A bright-but-textless frame decodes to stray punctuation, not Han.
    expect(keepOcrText('...!!', 0, 'chi_sim')).toBe('');
    expect(keepOcrText('|| —', 0, 'chi_sim')).toBe('');
  });

  it('empty text is always dropped', () => {
    expect(keepOcrText('', 0, 'chi_sim')).toBe('');
    expect(keepOcrText('', 90, 'eng')).toBe('');
  });
});

describe('normalizeOcrRegion', () => {
  it('passes a sane region through unchanged', () => {
    expect(normalizeOcrRegion({ x: 0.1, y: 0.7, w: 0.8, h: 0.2 })).toEqual({
      x: 0.1,
      y: 0.7,
      w: 0.8,
      h: 0.2,
    });
  });

  it('falls back to the default strip on garbage', () => {
    expect(normalizeOcrRegion(null)).toEqual(DEFAULT_OCR_REGION);
    expect(normalizeOcrRegion({ x: 'nope', y: NaN })).toEqual(DEFAULT_OCR_REGION);
  });

  it('enforces minimum size and keeps the region inside the frame', () => {
    const r = normalizeOcrRegion({ x: 0.99, y: 0.99, w: 0.001, h: 0.001 });
    expect(r.w).toBeGreaterThanOrEqual(0.05);
    expect(r.h).toBeGreaterThanOrEqual(0.03);
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });
});

describe('applyOcrSample', () => {
  it('opens the first cue at the sample time', () => {
    expect(applyOcrSample([], '你好', 12.5)).toEqual([open(12.5, '你好')]);
  });

  it('returns the SAME array while the line is unchanged (no re-render)', () => {
    const cues = [open(12.5, '你好')];
    expect(applyOcrSample(cues, '你好', 14)).toBe(cues);
  });

  it('ignores empty samples when nothing is open', () => {
    const cues: OcrCue[] = [{ start: 1, dur: 2, text: 'closed' }];
    expect(applyOcrSample(cues, '', 10)).toBe(cues);
    expect(applyOcrSample([], '', 10)).toEqual([]);
  });

  it('closes the open cue at the sample time when the line changes', () => {
    const step1 = applyOcrSample([], '第一句', 10);
    const step2 = applyOcrSample(step1, '第二句', 13.2);
    expect(step2).toHaveLength(2);
    expect(step2[0]!.text).toBe('第一句');
    expect(step2[0]!.dur).toBeCloseTo(3.2);
    expect(step2[1]).toEqual(open(13.2, '第二句'));
  });

  it('closes without opening when the strip goes blank', () => {
    const step1 = applyOcrSample([], '一句话', 10);
    const step2 = applyOcrSample(step1, '', 14);
    expect(step2).toEqual([{ start: 10, dur: 4, text: '一句话' }]);
  });

  it('clamps the closed duration after a backward seek', () => {
    const step1 = applyOcrSample([], '后面的句子', 100);
    const step2 = applyOcrSample(step1, '前面的句子', 20);
    expect(step2[0]!.dur).toBeGreaterThan(0);
    expect(step2[1]).toEqual(open(20, '前面的句子'));
  });

  it('stays bounded over a long session', () => {
    let cues: OcrCue[] = [];
    for (let i = 0; i < 1000; i++) {
      cues = applyOcrSample(cues, `line ${i}`, i * 3);
    }
    expect(cues.length).toBeLessThanOrEqual(400);
    expect(cues[cues.length - 1]!.text).toBe('line 999');
  });
});

describe('ocrTextSimilarity', () => {
  it('scores identical and disjoint strings at the extremes', () => {
    expect(ocrTextSimilarity('最后一条字幕在这里', '最后一条字幕在这里')).toBe(1);
    expect(ocrTextSimilarity('你好', '再见')).toBe(0);
    expect(ocrTextSimilarity('', '你好')).toBe(0);
  });

  it('rates a one-glyph misread of a long line as the same line', () => {
    expect(ocrTextSimilarity('最后一条字幕在这里', '最后一条学幕在这里')).toBeGreaterThanOrEqual(
      0.75,
    );
  });

  it('rates genuinely different lines low', () => {
    expect(ocrTextSimilarity('这是第一条测试字幕', '现在是第二条字幕')).toBeLessThan(0.75);
  });
});

describe('applyOcrSample — same-line variant merging', () => {
  // OCR reads of one on-screen line flicker between variants; those
  // must update the open cue in place, not litter the transcript.
  it('replaces the open cue in place on a similar, better read', () => {
    const step1 = applyOcrSample([], '最后一条学幕在这里', 10, 40);
    const step2 = applyOcrSample(step1, '最后一条字幕在这里', 11, 85);
    expect(step2).toHaveLength(1);
    expect(step2[0]!.text).toBe('最后一条字幕在这里');
    expect(step2[0]!.start).toBe(10); // keeps the line's first sighting
    expect(step2[0]!.dur).toBe(OCR_OPEN_DUR); // still open
  });

  it('drops a similar but clearly worse read', () => {
    const step1 = applyOcrSample([], '最后一条字幕在这里', 10, 90);
    const step2 = applyOcrSample(step1, '最后一条学幕在这里', 11, 20);
    expect(step2).toBe(step1);
  });

  it('still closes and reopens on short lines differing by one glyph', () => {
    // 他来了 / 她来了 are DIFFERENT lines — short lines are exempt
    // from similarity merging.
    const step1 = applyOcrSample([], '他来了', 10, 80);
    const step2 = applyOcrSample(step1, '她来了', 13, 80);
    expect(step2).toHaveLength(2);
  });
});
