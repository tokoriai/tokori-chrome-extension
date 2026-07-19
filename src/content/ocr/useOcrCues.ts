/**
 * useOcrCues — burned-in-subtitle capture for video-site overlays
 * (YouTube's player-bar OCR button / Subtitle menu → "OCR", and the
 * OCR-only surfaces like bilibili.tv where hardcoded subs are the norm).
 *
 * While active, samples the user-selected capture region of the playing
 * video (default: the bottom strip; drawn by dragging over the player
 * and persisted) and turns recognized text into the same cue shape the
 * caption pipeline renders, via lib/ocr-cues.
 *
 * Keeping the AI bill sane is the whole design:
 *   • Each tick the region is drawn to a small buffer (480×120 — big
 *     enough that a 3-4 px subtitle stroke at 1080p survives scaling)
 *     and bright pixels are counted per grid cell. That yields both a
 *     change signature (frames go to the vision model only when it
 *     flips) and a presence test.
 *   • Too few bright pixels = no subtitle on screen — the open cue is
 *     closed locally, zero API calls.
 *   • Calls are rate-limited and single-flight; a missed change is
 *     picked up by the next tick because the signature stays dirty.
 *
 * The translated bottom line reuses the extension's `translate`
 * action (desktop AI → keyless Google), one call per distinct line,
 * cached for the session.
 *
 * MSE-fed players (YouTube, bilibili.tv) let a <video> draw to canvas;
 * DRM'd players (Netflix, Disney+) black out frame capture, and a
 * plain cross-origin `src=` video taints the canvas — both surface as
 * a "frame capture blocked" error instead of silently never reading.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { sendMsgAsync } from '../../lib/chromeApi';
import {
  applyOcrSample,
  dilateMask,
  extractSubtitlePixels,
  normalizeOcrRegion,
  normalizeOcrText,
  tesseractLangFor,
  OCR_TEXTLIKE_BRIGHT_MAX,
  type OcrCue,
  type OcrRegion,
} from '../../lib/ocr-cues';
import type { LanguageCode } from '../../lib/languages';
import type { Settings } from '../../lib/settings';

/** Signature grid — one bright-content bit per cell. */
const SIG_W = 32;
const SIG_H = 8;
/** Analysis buffer: 15×15 px per grid cell. Resolution matters — at
 *  32×8 the strip's pixels average out and a subtitle stroke NEVER
 *  crosses the luma threshold (the original sin that made OCR sit
 *  silent forever). At 480 wide, a 3-4 px stroke from a 1080p frame
 *  keeps most of its brightness. */
const SAMPLE_W = SIG_W * 15;
const SAMPLE_H = SIG_H * 15;
/** ITU-R 601 luma above which a pixel counts as subtitle-ish (white
 *  and yellow subs both clear it; anti-aliased edges mostly do). */
const BRIGHT_LUMA = 175;
/** Sample-space "dark" threshold for the outline test. Looser than the
 *  extractor's (96): the downscale blends a 2 px outline with its
 *  bright fill/backdrop, so its sample pixels land mid-gray. A bright
 *  sky (190+) still stays clear of it. */
const DETECT_DARK_LUMA = 128;
/** Outline search radius in sample space — strokes are ~1-2 px here. */
const DETECT_OUTLINE_RADIUS = 2;
/** Candidate pixels in a cell before its signature bit sets (≥5%). */
const CELL_BRIGHT_MIN = 12;
/** Candidate pixels across the strip before we believe a subtitle is
 *  on screen at all (~0.2% of the buffer). Below it: blank → close the
 *  open cue locally, no API call. */
const PRESENCE_MIN = 100;
/** Bits that must flip before a frame counts as "changed". Kept low:
 *  a one-word line change only touches a couple of cells, and a missed
 *  flip here means showing the STALE line until the next blank gap
 *  (continuous dialogue cuts straight from line to line). Recognition
 *  is local/rate-limited, so a false positive costs ~nothing. */
const SIG_DELTA = 2;
/** Sample cadence: 4 Hz keeps detection latency ≤250 ms; each tick is
 *  one cheap canvas readback (~1 ms), calls still fire on change only. */
const TICK_MS = 250;
/** Floor between two recognition calls. The local engine is free and
 *  single-flight anyway, so it may go as fast as the sampler; the AI
 *  engine keeps a wide gap because every call is billed. */
const MIN_CALL_GAP_LOCAL_MS = 250;
const MIN_CALL_GAP_AI_MS = 1500;
/** Width cap for the crop sent to the AI engine (JPEG) — vision
 *  tokens are billed by size, and models read subtitles fine at this
 *  scale. */
const CROP_MAX_W_AI = 800;
/** Width cap for the local engine's prepared crop. Effectively "keep
 *  source resolution": downscaling blurs a 2 px sub outline and the
 *  inter-stroke gaps of CJK glyphs into the same mid-luma band, which
 *  is exactly where the extractor must draw its lines — recognition
 *  quality drops hard. The binarized PNG is nearly all white and
 *  compresses to a few kB regardless, and the engine is local, so
 *  only pathological (4K-frame) crops get scaled at all. */
const CROP_MAX_W_LOCAL = 1600;
/** Consecutive frame-readback failures before the player is declared
 *  capture-blocked (tainted canvas / DRM) and the error surfaces. */
const CAPTURE_FAILURE_LIMIT = 12;

interface OcrState {
  native: OcrCue[];
  error: string | null;
  /** Fatal config error (no AI key) — sampling stops entirely. */
  fatal: boolean;
}

export function useOcrCues(
  active: boolean,
  targetLang: LanguageCode | null,
  region: OcrRegion,
  /** EN pill — false skips the translate call per line entirely. */
  wantTranslation: boolean,
  /** The host page's player video ('#movie_player video' on YouTube). */
  videoSelector: string,
): { native: OcrCue[]; translated: OcrCue[]; error: string | null } {
  const [state, setState] = useState<OcrState>({ native: [], error: null, fatal: false });
  /** Live mirror for the sampler's interval closure — it needs the
   *  current fatal flag without re-arming on every state change. */
  const stateRef = useRef(state);
  stateRef.current = state;
  /** text → translation; bump `trVersion` to re-derive the cue list. */
  const translationsRef = useRef(new Map<string, string>());
  const [trVersion, setTrVersion] = useState(0);

  useEffect(() => {
    if (!active) {
      setState({ native: [], error: null, fatal: false });
      translationsRef.current = new Map();
      return;
    }

    const r = normalizeOcrRegion(region);
    const work = document.createElement('canvas');
    const sig = document.createElement('canvas');
    sig.width = SAMPLE_W;
    sig.height = SAMPLE_H;
    let lastSig: Uint8Array | null = null;
    let sigDirty = false;
    let inFlight = false;
    let lastCallAt = 0;
    let stopped = false;
    let captureFailures = 0;
    // Assume the slow (billed) cadence until settings say the local
    // engine will serve this language — then run at sampler speed,
    // binarize in-page, and talk to the OCR host directly. The warmup
    // ping spins the offscreen worker + model up right away, so the
    // FIRST line doesn't pay the engine's cold start.
    let callGapMs = MIN_CALL_GAP_AI_MS;
    let fastLocal = false;
    const tessLang = tesseractLangFor(targetLang);
    void sendMsgAsync<{ data?: Settings }>({ action: 'getSettings' }).then((res) => {
      if (stopped || !res.success) return;
      const s = (res as { data?: Settings }).data;
      const localReady =
        s?.ocrEngine !== 'ai' && !!tessLang && !!s?.ocrLocalLangs?.includes(tessLang);
      if (localReady) {
        callGapMs = MIN_CALL_GAP_LOCAL_MS;
        fastLocal = true;
        void sendMsgAsync({ action: 'ocrLocalWarmup', lang: targetLang || undefined });
      }
    });

    /** The capture region in source-video pixels; null while the frame
     *  is too small to matter (player still initialising). */
    const cropBox = (video: HTMLVideoElement) => {
      const sx = video.videoWidth * r.x;
      const sy = video.videoHeight * r.y;
      const sw = video.videoWidth * r.w;
      const sh = video.videoHeight * r.h;
      return sw >= 16 && sh >= 8 ? { sx, sy, sw, sh } : null;
    };

    interface TextBounds {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }

    /** One readback per tick: per-cell candidate-pixel counts become
     *  the change signature, the total doubles as the presence test,
     *  and the candidate bounding box (sample space) tells the OCR
     *  crop where the text actually is.
     *
     *  "Candidate" is bright AND near a dark pixel — the same outlined-
     *  text rule the extractor applies at full resolution. Counting
     *  plain brightness made the detector blind on bright scenes: over
     *  a sky the strip saturates, so white text appearing barely moved
     *  any cell and the signature never flipped (zero recognitions,
     *  "OCR watching…" forever) — while an empty bright strip kept
     *  presence high and hammered recognize with textless frames. When
     *  the outline rule finds nothing AND the bright coverage is small
     *  enough to be text rather than scenery, plain brightness still
     *  drives everything, so outline-less subs on quiet scenes keep
     *  working. */
    const readStrip = (
      video: HTMLVideoElement,
    ): { bits: Uint8Array; bright: number; bounds: TextBounds | null } | null => {
      const box = cropBox(video);
      const ctx = sig.getContext('2d', { willReadFrequently: true });
      if (!box || !ctx) return null;
      ctx.drawImage(video, box.sx, box.sy, box.sw, box.sh, 0, 0, SAMPLE_W, SAMPLE_H);
      const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const n = SAMPLE_W * SAMPLE_H;
      const brightMask = new Uint8Array(n);
      const darkish = new Uint8Array(n);
      let brightCount = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const luma = 0.299 * px[o]! + 0.587 * px[o + 1]! + 0.114 * px[o + 2]!;
        if (luma > BRIGHT_LUMA) {
          brightMask[i] = 1;
          brightCount++;
        } else if (luma < DETECT_DARK_LUMA) {
          darkish[i] = 1;
        }
      }
      const nearDark = dilateMask(darkish, SAMPLE_W, SAMPLE_H, DETECT_OUTLINE_RADIUS);
      const textish = new Uint8Array(n);
      let textishCount = 0;
      for (let i = 0; i < n; i++) {
        if (brightMask[i]! && nearDark[i]!) {
          textish[i] = 1;
          textishCount++;
        }
      }
      const active =
        textishCount < PRESENCE_MIN && brightCount > 0 && brightCount <= n * OCR_TEXTLIKE_BRIGHT_MAX
          ? brightMask
          : textish;

      const cellW = SAMPLE_W / SIG_W;
      const cellH = SAMPLE_H / SIG_H;
      const counts = new Uint16Array(SIG_W * SIG_H);
      let bright = 0;
      let x0 = SAMPLE_W;
      let y0 = SAMPLE_H;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < SAMPLE_H; y++) {
        const row = Math.floor(y / cellH) * SIG_W;
        for (let x = 0; x < SAMPLE_W; x++) {
          if (active[y * SAMPLE_W + x]!) {
            bright++;
            counts[row + Math.floor(x / cellW)]++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      const bits = new Uint8Array(SIG_W * SIG_H);
      for (let i = 0; i < bits.length; i++) bits[i] = counts[i]! >= CELL_BRIGHT_MIN ? 1 : 0;
      return { bits, bright, bounds: x1 >= 0 ? { x0, y0, x1, y1 } : null };
    };

    /** Crop for recognition: just the TEXT's bounding box (plus a
     *  margin) instead of the whole region — recognition time scales
     *  with area, and this is usually a 3-8× cut. In fast-local mode
     *  the crop is also binarized here (black text on white), so the
     *  OCR host feeds tesseract directly with zero extra passes. */
    const cropDataUrl = (
      video: HTMLVideoElement,
      bounds: TextBounds | null,
      prepared: boolean,
    ): string | null => {
      const box = cropBox(video);
      if (!box) return null;
      let { sx, sy, sw, sh } = box;
      if (bounds) {
        const mx = (sw * 24) / SAMPLE_W;
        const my = (sh * 12) / SAMPLE_H;
        const nx0 = Math.max(sx, sx + (bounds.x0 / SAMPLE_W) * sw - mx);
        const ny0 = Math.max(sy, sy + (bounds.y0 / SAMPLE_H) * sh - my);
        const nx1 = Math.min(sx + sw, sx + ((bounds.x1 + 1) / SAMPLE_W) * sw + mx);
        const ny1 = Math.min(sy + sh, sy + ((bounds.y1 + 1) / SAMPLE_H) * sh + my);
        if (nx1 - nx0 >= 16 && ny1 - ny0 >= 8) {
          sx = nx0;
          sy = ny0;
          sw = nx1 - nx0;
          sh = ny1 - ny0;
        }
      }
      // Cap the width; gently upscale very short crops so glyphs stay
      // above tesseract's comfortable minimum.
      const scale = Math.min(
        (prepared ? CROP_MAX_W_LOCAL : CROP_MAX_W_AI) / sw,
        Math.max(1, 64 / sh),
      );
      work.width = Math.round(sw * scale);
      work.height = Math.round(sh * scale);
      const ctx = work.getContext('2d', { willReadFrequently: prepared });
      if (!ctx) return null;
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);
      if (!prepared) return work.toDataURL('image/jpeg', 0.82);
      const data = ctx.getImageData(0, 0, work.width, work.height);
      extractSubtitlePixels(data.data, work.width, work.height);
      ctx.putImageData(data, 0, 0);
      return work.toDataURL('image/png');
    };

    /** Fast path: talk to the offscreen OCR host directly (one hop,
     *  one payload copy less). Falls back to the background route —
     *  which also (re)creates the offscreen document — whenever the
     *  direct message finds nobody home. */
    interface OcrCallResult {
      success: boolean;
      text?: string;
      confidence?: number;
      error?: string;
      errorCode?: string;
    }
    const callOcr = async (dataUrl: string, prepared: boolean): Promise<OcrCallResult> => {
      if (fastLocal && tessLang) {
        try {
          const direct = (await chrome.runtime.sendMessage({
            type: 'tokori-local-ocr',
            dataUrl,
            tessLang,
            prepared,
          })) as OcrCallResult | undefined;
          if (direct && typeof direct.success === 'boolean') {
            return direct;
          }
        } catch {
          /* offscreen not alive — background route recreates it */
        }
      }
      return (await sendMsgAsync<{ text?: string; errorCode?: string }>({
        action: 'ocrImage',
        dataUrl,
        lang: targetLang || undefined,
        prepared,
      })) as OcrCallResult;
    };

    const recognize = async (video: HTMLVideoElement, bounds: TextBounds | null) => {
      const t0 = video.currentTime;
      const prepared = fastLocal;
      const dataUrl = cropDataUrl(video, bounds, prepared);
      if (!dataUrl) return;
      inFlight = true;
      lastCallAt = Date.now();
      try {
        const res = await callOcr(dataUrl, prepared);
        if (stopped) return;
        if (!res.success) {
          const r = res as { error?: string; errorCode?: string };
          setState((prev) => ({
            ...prev,
            error: r.error || 'OCR failed.',
            fatal: r.errorCode === 'ocr_no_provider',
          }));
          return;
        }
        const text = normalizeOcrText(res.text || '');
        const conf = typeof res.confidence === 'number' ? res.confidence : 0;
        setState((prev) => {
          const native = applyOcrSample(prev.native, text, t0, conf);
          return native === prev.native && !prev.error
            ? prev
            : { native, error: null, fatal: false };
        });
        if (wantTranslation && text && targetLang && !translationsRef.current.has(text)) {
          translationsRef.current.set(text, ''); // claim before the async gap
          const tr = await sendMsgAsync<{ data?: { translation?: string } }>({
            action: 'translate',
            text,
            from: targetLang,
            to: 'en',
          });
          const translation = (tr as { data?: { translation?: string } }).data?.translation;
          if (!stopped && tr.success && translation) {
            translationsRef.current.set(text, translation);
            setTrVersion((v) => v + 1);
          }
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      if (stopped || document.hidden) return;
      const video = document.querySelector<HTMLVideoElement>(videoSelector);
      if (!video || video.paused || video.ended || !video.videoWidth) return;

      const strip = (() => {
        try {
          const s = readStrip(video);
          captureFailures = 0;
          return s;
        } catch {
          // Tainted canvas (DRM'd or plain cross-origin src) throws on
          // readback. One-off hiccups retry silently; a player that
          // blocks EVERY readback gets told to the user instead of
          // "OCR watching…" forever.
          if (++captureFailures === CAPTURE_FAILURE_LIMIT) {
            setState((prev) => ({
              ...prev,
              error: 'This player blocks frame capture — OCR cannot read it.',
            }));
          }
          return null;
        }
      })();
      if (!strip) return;

      const { bits, bright } = strip;
      let changed = !lastSig;
      if (lastSig) {
        let delta = 0;
        for (let i = 0; i < bits.length; i++) if (bits[i] !== lastSig[i]) delta++;
        changed = delta > SIG_DELTA;
      }
      lastSig = bits;
      sigDirty = sigDirty || changed;
      if (!sigDirty) return;

      // Not enough bright pixels for a subtitle: close the open cue
      // locally — no API call needed.
      if (bright < PRESENCE_MIN) {
        sigDirty = false;
        setState((prev) => {
          const native = applyOcrSample(prev.native, '', video.currentTime);
          return native === prev.native ? prev : { ...prev, native };
        });
        return;
      }

      const fatal = stateRef.current.fatal;
      if (fatal || inFlight || Date.now() - lastCallAt < callGapMs) return;
      sigDirty = false;
      void recognize(video, strip.bounds);
    }, TICK_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // Primitive region deps: the parent may rebuild the region object
    // each render; only real coordinate changes should re-arm (cues
    // survive a re-arm — only the signature/crop plumbing resets).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, targetLang, wantTranslation, videoSelector, region.x, region.y, region.w, region.h]);

  const translated = useMemo(
    () =>
      state.native
        .map((c) => {
          const tr = translationsRef.current.get(c.text);
          return tr ? { ...c, text: tr } : null;
        })
        .filter((c): c is OcrCue => c !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.native, trVersion],
  );

  return { native: state.native, translated, error: state.error };
}
