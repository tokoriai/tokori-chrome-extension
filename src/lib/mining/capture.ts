/**
 * Media capture for the sentence miner.
 *
 * Both helpers operate on a live `<video>` element provided by the host
 * page (YouTube's <video> for now; Netflix later). They never touch
 * chrome.* — the content script is the right place to call them so the
 * video element actually exists in the same realm.
 *
 * Output shape is deliberately friendly to message-passing:
 * `dataUrl` (base64) round-trips through `chrome.runtime.sendMessage`
 * without needing transferables, and lands directly in the format both
 * AnkiConnect (`storeMediaFile`) and the Tokori desktop's
 * `updateVocabFields()` already ingest.
 */

export interface FrameCapture {
  dataUrl: string; // "data:image/jpeg;base64,…"
  mime: 'image/jpeg' | 'image/png';
  width: number; // captured dimensions (after scaling)
  height: number;
  takenAtSec: number; // video.currentTime when the frame was grabbed
  byteLength: number; // approximate base64 payload size
}

export interface ClipCapture {
  dataUrl: string; // "data:video/webm;base64,…"
  mime: string; // resolved MIME including codec params
  durationSec: number;
  width: number;
  height: number;
  byteLength: number;
}

export interface FrameOpts {
  /** Longest edge of the output JPEG. Smaller = faster save and smaller
   *  payload. Default 640 — fits well under Anki + Tokori-desktop image
   *  size budgets. */
  maxWidth?: number;
  /** JPEG quality 0–1. Default 0.8 — visually lossless for screenshots
   *  while still ~30% of PNG's bytes. */
  quality?: number;
}

const DEFAULT_FRAME_OPTS: Required<FrameOpts> = {
  maxWidth: 640,
  quality: 0.8,
};

/** Aspect-preserving downscale of `srcW`×`srcH` to fit within `maxWidth`.
 *  Scales by the longer edge so portrait sources also stay under budget;
 *  never upscales (scale is capped at 1). Pure — unit tested. */
export function scaleToFit(
  srcW: number,
  srcH: number,
  maxWidth: number,
): { w: number; h: number; scale: number } {
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxWidth ? maxWidth / longest : 1;
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale), scale };
}

/** Grab the current frame of `video` as a JPEG data URL. Throws if the
 *  video isn't ready (`readyState < HAVE_CURRENT_DATA`) or if the
 *  canvas is tainted by cross-origin source media. */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  opts: FrameOpts = {},
): Promise<FrameCapture> {
  const { maxWidth, quality } = { ...DEFAULT_FRAME_OPTS, ...opts };
  if (!video) throw new Error('No <video> element provided.');
  if (video.readyState < 2) {
    throw new Error('Video is not ready yet — try again once playback has loaded.');
  }
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) {
    throw new Error('Video has no intrinsic dimensions yet.');
  }
  const { w, h } = scaleToFit(srcW, srcH, maxWidth);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas context unavailable in this browser.');
  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch (e) {
    throw new Error(`Couldn't draw the frame: ${(e as Error).message}`, { cause: e });
  }
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    // `SecurityError: tainted canvas` — host video is served without
    // CORS headers (rare on YouTube). Surface plain text so the modal
    // can tell the user what to do instead of failing silently.
    throw new Error(
      "The video frame is protected and can't be captured " +
        '(cross-origin source). Try a different video.',
      { cause: e },
    );
  }
  return {
    dataUrl,
    mime: 'image/jpeg',
    width: w,
    height: h,
    takenAtSec: video.currentTime,
    byteLength: Math.ceil(((dataUrl.length - 'data:image/jpeg;base64,'.length) * 3) / 4),
  };
}

export interface ClipOpts {
  /** Total clip length in seconds. Capped at 8s here so the WebM stays
   *  under a few MB even for 480p sources. */
  durationSec: number;
  /** Optional seek-back amount. When set, we rewind the player to
   *  `startSec`, record `durationSec`, then restore the original
   *  playback state. When omitted, recording starts at `currentTime`
   *  (don't seek — useful for "capture the next 4s as the user
   *  watches"). */
  startSec?: number;
  /** Cap on the captured video's height (scaled by the source via
   *  captureStream automatically; we can't actually downscale a media
   *  stream client-side, but we record at the source resolution and
   *  rely on the duration cap to keep file size in check). Tracked so
   *  upstream code can label the clip with its actual resolution. */
  maxHeight?: number;
  /** Preferred output format. WebM (VP8/Opus) is the safe default —
   *  Chrome's MediaRecorder always supports it, and both Anki + the
   *  desktop player handle it. */
  mimeType?: string;
}

const CLIP_DURATION_CAP_SEC = 8;

/** Record a short A/V clip from `video.captureStream()`. Restores
 *  the original `currentTime` + `paused` state when done so the user's
 *  playback isn't disrupted (much). */
export async function recordVideoClip(
  video: HTMLVideoElement,
  opts: ClipOpts,
): Promise<ClipCapture> {
  if (!video) throw new Error('No <video> element provided.');
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not available in this browser.');
  }
  const captureStream =
    (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream ||
    (video as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
  if (typeof captureStream !== 'function') {
    throw new Error("This browser cannot capture the video element's stream.");
  }
  const stream = captureStream.call(video) as MediaStream;
  if (!stream || stream.getTracks().length === 0) {
    throw new Error('The video has no usable track to record.');
  }

  const durationSec = Math.min(Math.max(0.5, opts.durationSec), CLIP_DURATION_CAP_SEC);
  const mimeType = pickClipMime(opts.mimeType);

  const originalTime = video.currentTime;
  const wasPaused = video.paused;

  // If the caller asked for a specific start time and we're allowed to
  // seek, rewind first. Otherwise we record from "now" — useful for
  // live mining where seeking would interrupt the user.
  if (opts.startSec != null && Math.abs(video.currentTime - opts.startSec) > 0.05) {
    await seekVideo(video, opts.startSec);
  }
  if (wasPaused) {
    try {
      await video.play();
    } catch {
      /* user-gesture restrictions — proceed anyway */
    }
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const finished = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject((e as ErrorEvent).error || new Error('MediaRecorder error'));
  });
  recorder.start();
  await sleep(durationSec * 1000);
  if (recorder.state !== 'inactive') recorder.stop();
  await finished;

  // Restore playback state so the user's watching experience isn't
  // disrupted past the clip's tail.
  if (wasPaused && !video.paused) video.pause();
  if (opts.startSec != null) {
    try {
      video.currentTime = originalTime;
    } catch {
      /* not always seekable */
    }
  }

  const blob = new Blob(chunks, { type: mimeType });
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    mime: mimeType,
    durationSec,
    width: video.videoWidth,
    height: video.videoHeight,
    byteLength: blob.size,
  };
}

/** Pick the best WebM mimeType the current browser supports. Order
 *  prefers VP9/Opus (smaller files) but falls back to VP8/Opus and
 *  then the generic `video/webm` if neither is reported. */
export function pickClipMime(preferred?: string): string {
  const candidates = [
    preferred,
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(typeof r.result === 'string' ? r.result : '');
    r.onerror = () => reject(r.error || new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = Math.max(0, t);
    } catch {
      resolve();
    }
    // Safety: if `seeked` never fires (rare), resolve after 800ms.
    setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, 800);
  });
}
