/**
 * OCR subtitle stream assembly — turns per-sample recognition results
 * ("at video time t the burned-in subtitle said X") into the same
 * `{ start, dur, text }` cue list the caption overlay renders, so
 * everything downstream (tokenizing, dictionary clicks, mining with
 * timing, the transcript sidebar) works on OCR'd lines unchanged.
 *
 * Unlike a fetched track, an OCR track grows forward in time: the
 * newest cue stays "open" (a long placeholder duration) until a later
 * sample shows different text — or none — which closes it at that
 * sample's timestamp. Pure data-in data-out; the sampling loop and the
 * OCR calls live in the content-script hook.
 */

export interface OcrCue {
  start: number;
  dur: number;
  text: string;
  /** Mean recognition confidence of the read this text came from —
   *  only set by the OCR pipeline (local engine), and only when the
   *  engine reported one. Lets a later, better read of the SAME line
   *  replace a flickery variant in place. */
  conf?: number;
}

/** Where on the frame the burned-in subtitles live, as fractions of
 *  the video's width/height — user-selected by dragging over the
 *  player, persisted per browser. */
export interface OcrRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bottom strip — where burned subs usually are. Used until the user
 *  draws their own region. */
export const DEFAULT_OCR_REGION: OcrRegion = { x: 0, y: 0.68, w: 1, h: 0.32 };

/** Smallest sensible region (fractions) — anything tighter is a
 *  misdrag, not a subtitle field. */
export const MIN_OCR_REGION_W = 0.05;
export const MIN_OCR_REGION_H = 0.03;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Coerce a stored/drawn region into a usable one: numbers only,
 *  clamped into the frame, minimum size enforced (pulling the origin
 *  back when the region would spill past the right/bottom edge).
 *  Garbage in → the default strip out. */
export function normalizeOcrRegion(raw: unknown): OcrRegion {
  const r = (raw ?? {}) as Partial<Record<keyof OcrRegion, unknown>>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  let x = clamp01(num(r.x, DEFAULT_OCR_REGION.x));
  let y = clamp01(num(r.y, DEFAULT_OCR_REGION.y));
  let w = clamp01(num(r.w, DEFAULT_OCR_REGION.w));
  let h = clamp01(num(r.h, DEFAULT_OCR_REGION.h));
  w = Math.max(w, MIN_OCR_REGION_W);
  h = Math.max(h, MIN_OCR_REGION_H);
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  return { x, y, w, h };
}

/** Placeholder duration of the still-open newest cue. Long enough to
 *  count as "active" until the next sample closes it; also the marker
 *  by which `applyOcrSample` recognizes the open cue. */
export const OCR_OPEN_DUR = 600;

/** Shortest closed cue we keep — a same-second flicker (OCR noise)
 *  would otherwise litter the transcript. */
const MIN_CLOSED_DUR = 0.3;

/** Keep the track bounded over a long watch session. */
const MAX_OCR_CUES = 400;

/** Collapse whitespace/newlines the model may echo from a two-line
 *  subtitle into the single-line text the overlay expects. */
export function normalizeOcrText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Tesseract language pack for one of our language codes — the local
 *  OCR engine's model id. Null = no pack mapped (AI fallback only). */
export function tesseractLangFor(lang: string | null | undefined): string | null {
  switch ((lang || '').toLowerCase()) {
    case 'zh':
      return 'chi_sim';
    case 'ja':
      return 'jpn';
    case 'ko':
      return 'kor';
    case 'en':
      return 'eng';
    case 'fr':
      return 'fra';
    case 'es':
      return 'spa';
    case 'de':
      return 'deu';
    case 'pt':
      return 'por';
    case 'it':
      return 'ita';
    case 'ru':
      return 'rus';
    default:
      return null;
  }
}

// ── Subtitle pixel extraction ──────────────────────────────────────

/** Luma above which a pixel can be subtitle FILL (white and yellow
 *  subs, and most of their anti-aliased edges, all clear it). */
export const OCR_TEXT_LUMA = 175;
/** Luma below which a pixel is "dark" — a glyph outline, a drop
 *  shadow, or a dark scene behind the text. */
export const OCR_OUTLINE_LUMA = 96;
/** How far (px, Chebyshev) subtitle fill may sit from the nearest
 *  dark pixel and still count as outlined text. The local path's crop
 *  arrives at source resolution (CROP_MAX_W_LOCAL), where hard-sub
 *  outlines run 2-5 px thick and strokes ~4-12 px wide. */
export const OCR_OUTLINE_RADIUS = 4;
/** Bright fraction of a buffer above which "no outlined text found"
 *  means a bright SCENE (sky, white wall) rather than outline-less
 *  subtitles — a plain-brightness fallback must not fire there (for
 *  the extractor it would feed tesseract a solid black slab; for the
 *  change detector it would blind the signature). Tight text areas
 *  run ~15-35% bright; bright scenery runs well past it. */
export const OCR_TEXTLIKE_BRIGHT_MAX = 0.35;
/** Extracted-pixel fraction below which extraction "found nothing". */
const EXTRACT_MIN_FRACTION = 0.001;

/**
 * Turn an RGBA video-frame crop into the black-text-on-white page
 * tesseract wants, in place.
 *
 * The naive rule — every bright pixel is text — collapses the moment
 * the SCENE inside the capture region is bright too (sky, white
 * clothing, a sunlit wall): the whole strip binarizes into a black
 * slab with white text-holes and tesseract reads noise (conf=0 empties
 * and stray digits). Real burned-in subtitles stay readable over
 * exactly those scenes because they carry a dark outline or drop
 * shadow, so keep only bright pixels with a dark pixel within
 * OCR_OUTLINE_RADIUS: glyph fill survives (its outline — or a dark
 * scene — is adjacent), bare scene brightness falls away. On a dark
 * scene every bright pixel qualifies, so this degrades to exactly the
 * plain threshold there — zero regression on the common case.
 *
 * "Near dark" alone still keeps the rim of scene hugging the
 * outline's OUTSIDE — every glyph grows a black halo shell tesseract
 * misreads badly. Fill and halo differ topologically: the scene can
 * REACH the halo from the crop border without stepping on a dark
 * pixel, while fill sits sealed inside its outline. A border flood
 * over non-dark pixels marks everything "outside"; candidates must be
 * inside. On a dark scene the flood never leaves the border (it is
 * dark), nothing is marked, and the whole rule collapses to the plain
 * threshold — zero regression on the common case by construction.
 * Known cost: the enclosed counter of 口-like glyphs floods black.
 * (Smarter per-pixel separators tried and reverted: enclosure
 * ("dark on 2+ sides") clogs inter-stroke gaps into blobs; bounded-
 * run analysis shatters strokes wherever H.264 ringing dips one fill
 * pixel below threshold.)
 *
 * Outline-less subs over a MID-GRAY scene (no dark pixels anywhere
 * near the glyphs) would now be lost even though the plain threshold
 * handled them fine, so when extraction finds ~nothing AND the bright
 * coverage looks like text rather than scenery, the plain threshold is
 * used after all.
 *
 * Two cleanup passes then strip what the outline rule lets through on
 * BUSY bright scenes (bright pixels near a dark pattern edge / window
 * frame / clothing fold pass it too): isolated specks go (a glyph
 * stroke pixel has a dense text neighborhood; scattered scene hits
 * don't), and rows with almost no text pixels are blanked (scene
 * noise spreads over the whole crop; subtitle lines are dense bands —
 * a per-row gate keeps two-line subs intact where "pick the dominant
 * band" would drop one).
 */
export function extractSubtitlePixels(px: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const bright = new Uint8Array(n);
  const dark = new Uint8Array(n);
  let brightCount = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const luma = 0.299 * px[o]! + 0.587 * px[o + 1]! + 0.114 * px[o + 2]!;
    if (luma > OCR_TEXT_LUMA) {
      bright[i] = 1;
      brightCount++;
    } else if (luma < OCR_OUTLINE_LUMA) {
      dark[i] = 1;
    }
  }
  const nearDark = dilateMask(dark, w, h, OCR_OUTLINE_RADIUS);

  // Border flood: mark every non-dark pixel reachable from the crop
  // border without crossing dark. The crop carries a margin around the
  // text (cropDataUrl pads the detector's bounding box), so the border
  // is scene, never glyph.
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qt = 0;
  const seed = (i: number) => {
    if (!outside[i]! && !dark[i]!) {
      outside[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  for (let qh = 0; qh < qt; qh++) {
    const i = queue[qh]!;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }

  let kept = 0;
  for (let i = 0; i < n; i++) if (bright[i]! && nearDark[i]! && !outside[i]!) kept++;
  const usePlain =
    kept < n * EXTRACT_MIN_FRACTION &&
    brightCount > 0 &&
    brightCount <= n * OCR_TEXTLIKE_BRIGHT_MAX;
  const text = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    text[i] = (usePlain ? bright[i]! : bright[i]! && nearDark[i]! && !outside[i]!) ? 1 : 0;
  }

  // Speck removal: a text pixel with ≤1 text neighbour (8-way) is
  // scene noise, not part of a stroke.
  const solid = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!text[i]) continue;
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          neighbours += text[yy * w + xx]!;
        }
      }
      solid[i] = neighbours >= 2 ? 1 : 0;
    }
  }

  // Row gate: blank rows carrying only a trace of text. Capped in
  // absolute terms so a dense long first line cannot starve a short
  // second line (two-line subs where one line is a couple of glyphs).
  const rowCount = new Uint32Array(h);
  let maxRow = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) c += solid[y * w + x]!;
    rowCount[y] = c;
    if (c > maxRow) maxRow = c;
  }
  const rowMin = Math.max(2, Math.min(16, maxRow * 0.1));

  for (let i = 0; i < n; i++) {
    const v = solid[i]! && rowCount[(i / w) | 0]! >= rowMin ? 0 : 255;
    const o = i * 4;
    px[o] = v;
    px[o + 1] = v;
    px[o + 2] = v;
    px[o + 3] = 255;
  }
}

/** 0/1 box dilation ("any set bit within radius r"), as two sliding-
 *  window passes — O(n) whatever the radius. Exported for the capture
 *  hook's change detector, which builds the same outlined-bright mask
 *  at sample resolution. */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let cnt = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) cnt += mask[row + x]!;
    for (let x = 0; x < w; x++) {
      horiz[row + x] = cnt > 0 ? 1 : 0;
      const add = x + r + 1;
      if (add < w) cnt += mask[row + add]!;
      const rem = x - r;
      if (rem >= 0) cnt -= mask[row + rem]!;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) cnt += horiz[y * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = cnt > 0 ? 1 : 0;
      const add = y + r + 1;
      if (add < h) cnt += horiz[add * w + x]!;
      const rem = y - r;
      if (rem >= 0) cnt -= horiz[rem * w + x]!;
    }
  }
  return out;
}

const CJK_CHAR =
  '[\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af\\u3000-\\u303f\\uff01-\\uff60]';
const CJK_GAP_RE = new RegExp(`(${CJK_CHAR})\\s+(?=${CJK_CHAR})`, 'g');

/** Tesseract-flavoured cleanup: the engine inserts spurious spaces
 *  between CJK glyphs ("你 好 世 界") — collapse those for CJK packs,
 *  then apply the usual whitespace normalization. Vertical scene edges
 *  (door frames, poles) that survive pixel extraction decode as "|",
 *  which no CJK subtitle uses — drop those too. Latin packs only get
 *  the normalization ("|" could be an l/I misread there). */
export function cleanOcrTextForLang(raw: string, tessLang: string): string {
  if (
    tessLang === 'chi_sim' ||
    tessLang === 'chi_tra' ||
    tessLang === 'jpn' ||
    tessLang === 'kor'
  ) {
    const text = normalizeOcrText(raw.replace(/[|｜]+/g, ' '));
    return text.replace(CJK_GAP_RE, '$1');
  }
  return normalizeOcrText(raw);
}

/** Latin-pack mean-confidence floor below which a positive-confidence
 *  read is treated as noise. (CJK packs don't use this — tesseract's
 *  confidence is unreliable there; see keepOcrText.) */
export const MIN_OCR_CONFIDENCE = 35;

const OCR_CJK_TESS_LANGS = new Set(['chi_sim', 'chi_tra', 'jpn', 'kor']);
/** At least one Han / kana / hangul glyph. */
const CJK_GLYPH_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/**
 * Decide what one OCR frame's (already whitespace-cleaned) recognized
 * text contributes to the cue stream — the text to emit, or '' to drop.
 *
 * The confidence handling is the subtle part, and it was a real bug.
 * tesseract.js v7 under its default `{ text }` output does NOT populate
 * `MeanTextConf()` (it needs a result iterator it never builds), so it
 * reports `confidence` as 0 — or a meaningless low value — even for a
 * perfectly clean read. Gating CJK on that number at ANY threshold
 * silently dropped real subtitle lines ("OCR watching…" forever even
 * though tesseract had read the line). So:
 *   • CJK packs: ignore the (unreliable) confidence entirely and gate on
 *     content instead — keep the text iff it has at least one real
 *     Han/kana/hangul glyph, which rejects the stray punctuation a
 *     bright-but-textless frame decodes to. The presence detector
 *     upstream already drops blank frames, so this is enough.
 *   • Latin packs: confidence IS reliable there, so a positive score
 *     below the floor is a genuine low-quality read → drop it. (0 still
 *     means "unknown" → trust the text.)
 */
export function keepOcrText(cleaned: string, confidence: number, tessLang: string): string {
  if (!cleaned) return '';
  if (OCR_CJK_TESS_LANGS.has(tessLang)) {
    return CJK_GLYPH_RE.test(cleaned) ? cleaned : '';
  }
  if (confidence > 0 && confidence < MIN_OCR_CONFIDENCE) return '';
  return cleaned;
}

/** Similarity (0-1, Levenshtein-based) at or above which two nonempty
 *  reads count as the same subtitle line seen twice. */
export const OCR_SAME_LINE_SIMILARITY = 0.75;
/** Similarity merging needs this many glyphs on BOTH sides — short
 *  lines legitimately differ by one glyph (他来了 / 她来了). */
const OCR_MERGE_MIN_LEN = 4;

/** 0-1 text similarity: 1 − editDistance / longerLength. */
export function ocrTextSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

/**
 * Fold one OCR sample into the cue list. `text` must already be
 * normalized ('' = no subtitle visible); `t` is the video time the
 * frame was captured at (NOT when the OCR response returned); `conf`
 * is the engine's mean confidence for the read, 0 when unknown.
 *
 * Returns the SAME array instance when nothing changed, so React
 * state consumers can skip re-renders on the common "same line is
 * still on screen" case.
 *
 * A nonempty read that is merely a VARIANT of the open cue's text
 * (high similarity — OCR noise flickering a glyph or two on the same
 * on-screen line) does not close and reopen the cue: the open cue is
 * updated in place when the new read is at least about as confident,
 * and the sample is dropped when it is clearly worse. The line keeps
 * its first-sighting timestamp and the best read wins, instead of the
 * transcript collecting one cue per misread.
 */
export function applyOcrSample(cues: OcrCue[], text: string, t: number, conf = 0): OcrCue[] {
  const last = cues[cues.length - 1];
  const lastOpen = !!last && last.dur === OCR_OPEN_DUR;

  // Same text still showing (or still nothing) — no change.
  if (lastOpen && last.text === text) return cues;
  if (!lastOpen && !text) return cues;

  if (
    lastOpen &&
    text &&
    // A sample from BEFORE the open cue's start is a backward seek —
    // a new sighting however similar the text; close and reopen.
    t >= last!.start &&
    Math.min(text.length, last!.text.length) >= OCR_MERGE_MIN_LEN &&
    ocrTextSimilarity(text, last!.text) >= OCR_SAME_LINE_SIMILARITY
  ) {
    // Clearly worse read of the same line → keep what we have.
    if (conf < (last!.conf ?? 0) * 0.75) return cues;
    const next = cues.slice();
    next[next.length - 1] = { ...last!, text, ...(conf > 0 ? { conf } : {}) };
    return next;
  }

  const next = cues.slice();
  if (lastOpen) {
    // Close the open cue at this sample. A backward seek can put `t`
    // before the cue's start — clamp instead of emitting negative time.
    next[next.length - 1] = { ...last!, dur: Math.max(MIN_CLOSED_DUR, t - last!.start) };
  }
  if (text) {
    next.push({ start: t, dur: OCR_OPEN_DUR, text, ...(conf > 0 ? { conf } : {}) });
  }
  return next.length > MAX_OCR_CUES ? next.slice(next.length - MAX_OCR_CUES) : next;
}
