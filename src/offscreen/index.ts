/**
 * Offscreen OCR host — the local, no-API-key engine behind the
 * YouTube burned-in-subtitle mode.
 *
 * Lives in a chrome.offscreen document because tesseract.js needs a
 * Web Worker (MV3 service workers can't spawn one) and WebAssembly
 * (allowed here via the manifest's extension_pages CSP). The runtime
 * (worker + SIMD core) ships with the extension under /tesseract/;
 * language packs download once from the tessdata CDN and persist in
 * this origin's IndexedDB — tesseract.js caches them itself.
 *
 * Messages (from the background worker):
 *   {type:'tokori-local-ocr', dataUrl, tessLang}   → {success, text} | {success:false, error}
 *   {type:'tokori-local-ocr-warmup', tessLang}     → same, text:'' — downloads/caches the pack
 * Progress during downloads is broadcast as
 *   {type:'tokori-local-ocr-progress', tessLang, status, progress}
 * for the Options page to render.
 */

import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import { cleanOcrTextForLang, extractSubtitlePixels, keepOcrText } from '../lib/ocr-cues';

let worker: TesseractWorker | null = null;
let workerLang = '';
let chain: Promise<unknown> = Promise.resolve();

async function ensureWorker(tessLang: string): Promise<TesseractWorker> {
  if (worker && workerLang === tessLang) return worker;
  if (worker) {
    await worker.terminate().catch(() => {});
    worker = null;
  }
  const base = chrome.runtime.getURL('tesseract');
  const w = await createWorker(tessLang, 1, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
    // CRITICAL for MV3: tesseract's default spawns a tiny BLOB worker
    // that `importScripts(workerPath)` — extension-page CSP blocks
    // that combination ("Failed to execute 'importScripts'"). Spawning
    // the worker directly from the extension URL is allowed by 'self'.
    // (oem=1 above already selects the LSTM-only core + the smaller
    // `4.0.0_best_int` language packs on the jsdelivr CDN; packs cache
    // in IndexedDB after the first fetch.)
    //
    // On load the core used to console.error ~10 HARMLESS "Warning:
    // Parameter not found: language_model_ngram_on"-style lines (the
    // traineddata config lists legacy-engine parameters the LSTM-only
    // core doesn't implement; it warns and moves on — recognition is
    // unaffected). Chrome's extension-error collector showed each one
    // as a red error, so copy-tesseract.mjs now mutes exactly that
    // class inside the shipped worker.
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'loading language traineddata' || m.progress === 1) {
        void chrome.runtime
          .sendMessage({
            type: 'tokori-local-ocr-progress',
            tessLang,
            status: m.status,
            progress: m.progress ?? 0,
          })
          .catch(() => {});
      }
    },
  });
  await w.setParameters({
    // Subtitles are one or two short lines — a uniform block.
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    // Input is always black-text-on-white after binarization — skip
    // tesseract's inversion detection pass.
    tessedit_do_invert: '0',
    // Vertical scene edges that survive pixel extraction decode as
    // bars; no CJK subtitle uses them, so ban them at the engine level
    // (Latin packs keep them — could be an l/I misread).
    ...(tessLang.startsWith('chi') || tessLang === 'jpn' || tessLang === 'kor'
      ? { tessedit_char_blacklist: '|｜' }
      : {}),
  });
  worker = w;
  workerLang = tessLang;
  return w;
}

/** Extract the subtitle from the crop: outlined bright pixels → black
 *  text on a white page, everything else (including bright scenery)
 *  dropped — see lib/ocr-cues.extractSubtitlePixels. Tesseract expects
 *  document-style input; raw video frames sink its accuracy. Returns
 *  the canvas itself — tesseract accepts it directly, skipping a PNG
 *  re-encode per frame. */
async function binarize(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('Could not decode the frame crop.'));
    img.src = dataUrl;
  });
  // Upscale only genuinely small crops (tight user-drawn regions) —
  // glyphs from a full-width strip are already big enough, and every
  // extra pixel is recognition time.
  const scale = img.width < 600 ? 2 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable.');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  extractSubtitlePixels(data.data, canvas.width, canvas.height);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

async function recognize(
  dataUrl: string,
  tessLang: string,
  prepared: boolean,
): Promise<{ text: string; confidence: number }> {
  const t0 = performance.now();
  const w = await ensureWorker(tessLang);
  // Fast path: the content script already sent a binarized crop of
  // just the text's bounding box — feed it straight to tesseract.
  const page = prepared ? dataUrl : await binarize(dataUrl);
  const { data } = await w.recognize(page);
  const conf = data.confidence ?? 0;
  const cleaned = cleanOcrTextForLang(data.text || '', tessLang);
  // keepOcrText owns the (subtle) confidence handling — see lib/ocr-cues.
  const kept = keepOcrText(cleaned, conf, tessLang);
  // Filterable diagnostic (DevTools console filter `[tokori-ocr`), visible
  // at the default console level (console.log, not debug). Remove once the
  // pipeline is confirmed working in the field.
  console.log(
    `[tokori-ocr] ${tessLang} conf=${Math.round(conf)} ${Math.round(performance.now() - t0)}ms ` +
      `${kept ? 'kept' : 'DROPPED'} text=${JSON.stringify(cleaned)}`,
  );
  return { text: kept, confidence: conf };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const req = request as { type?: string; dataUrl?: string; tessLang?: string; prepared?: boolean };
  if (req.type !== 'tokori-local-ocr' && req.type !== 'tokori-local-ocr-warmup') return false;
  const tessLang = req.tessLang || 'eng';
  // Serialize on one worker — parallel recognize calls on a single
  // tesseract worker interleave and corrupt each other's results.
  const job = chain.then(async () => {
    if (req.type === 'tokori-local-ocr-warmup') {
      await ensureWorker(tessLang);
      return { text: '', confidence: 0 };
    }
    return recognize(req.dataUrl || '', tessLang, !!req.prepared);
  });
  chain = job.catch(() => {});
  job
    .then((r) => sendResponse({ success: true, text: r.text, confidence: r.confidence }))
    .catch((e) =>
      sendResponse({ success: false, error: e instanceof Error ? e.message : String(e) }),
    );
  return true;
});
