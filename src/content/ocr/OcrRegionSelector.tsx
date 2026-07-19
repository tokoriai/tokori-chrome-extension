/**
 * OcrRegionSelector — full-player drag overlay for choosing where the
 * burned-in subtitles live. Shown when OCR mode starts without a saved
 * region, or from the toolbar's "⛶ Region" chip.
 *
 * The overlay tracks the <video> element's rect (not the player
 * chrome), so the drawn rectangle maps 1:1 onto frame fractions —
 * exactly the coordinates the OCR sampler crops with. Esc cancels; a
 * drag smaller than the minimum region is treated as a misclick and
 * ignored.
 */

import { useEffect, useRef, useState } from 'react';
import { s } from '../../lib/theme';
import {
  DEFAULT_OCR_REGION,
  MIN_OCR_REGION_H,
  MIN_OCR_REGION_W,
  normalizeOcrRegion,
  type OcrRegion,
} from '../../lib/ocr-cues';

export function OcrRegionSelector({
  current,
  onSelect,
  onCancel,
  videoSelector,
}: {
  /** Already-saved region, outlined for reference while redrawing. */
  current: OcrRegion | null;
  onSelect: (region: OcrRegion) => void;
  onCancel: () => void;
  /** The host page's player video ('#movie_player video' on YouTube). */
  videoSelector: string;
}) {
  const [videoRect, setVideoRect] = useState<DOMRect | null>(null);
  /** Live drag rectangle in viewport coords (render only — the commit
   *  math reads the ref so a fast mouseup never sees stale state). */
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Track the video element's rect each frame — theater/fullscreen
  // toggles and window resizes mid-selection stay accurate.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = document.querySelector<HTMLVideoElement>(videoSelector);
      const rect = v?.getBoundingClientRect() ?? null;
      setVideoRect((prev) => {
        if (!prev || !rect) return rect;
        return Math.abs(prev.left - rect.left) < 0.5 &&
          Math.abs(prev.top - rect.top) < 0.5 &&
          Math.abs(prev.width - rect.width) < 0.5 &&
          Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : rect;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoSelector]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  if (!videoRect || videoRect.width < 40) return null;

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const d = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY };
    dragRef.current = d;
    setDrag(d);
    const onMove = (ev: MouseEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const next = { ...cur, x2: ev.clientX, y2: ev.clientY };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      const rect = videoRect;
      const x = (Math.min(cur.x1, cur.x2) - rect.left) / rect.width;
      const y = (Math.min(cur.y1, cur.y2) - rect.top) / rect.height;
      const w = Math.abs(cur.x2 - cur.x1) / rect.width;
      const h = Math.abs(cur.y2 - cur.y1) / rect.height;
      // A tap / tiny drag is a misclick, not a region — stay in
      // selection mode so the user can try again.
      if (w < MIN_OCR_REGION_W || h < MIN_OCR_REGION_H) return;
      onSelect(normalizeOcrRegion({ x, y, w, h }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const chip = (extra?: object) =>
    s({
      background: 'rgba(0,0,0,0.8)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '999px',
      padding: '4px 12px',
      fontSize: '12px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      ...extra,
    });

  const toBox = (r: OcrRegion) => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.w * 100}%`,
    height: `${r.h * 100}%`,
  });

  return (
    <div
      onMouseDown={startDrag}
      style={s({
        position: 'fixed',
        left: `${videoRect.left}px`,
        top: `${videoRect.top}px`,
        width: `${videoRect.width}px`,
        height: `${videoRect.height}px`,
        zIndex: '2147483646',
        cursor: 'crosshair',
        background: 'rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
      })}
    >
      {/* Existing region, for reference while redrawing. */}
      {current && !drag && (
        <div
          style={s({
            position: 'absolute',
            ...toBox(current),
            border: '1px dashed rgba(255,255,255,0.5)',
            pointerEvents: 'none',
          })}
        />
      )}

      {/* Live drag rectangle. */}
      {drag && (
        <div
          style={s({
            position: 'absolute',
            left: `${Math.min(drag.x1, drag.x2) - videoRect.left}px`,
            top: `${Math.min(drag.y1, drag.y2) - videoRect.top}px`,
            width: `${Math.abs(drag.x2 - drag.x1)}px`,
            height: `${Math.abs(drag.y2 - drag.y1)}px`,
            border: '2px solid #4ea1ff',
            background: 'rgba(78,161,255,0.18)',
            pointerEvents: 'none',
          })}
        />
      )}

      {/* Instructions + escape hatches. */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={s({
          position: 'absolute',
          top: '10%',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          pointerEvents: 'auto',
        })}
      >
        <span style={chip({ cursor: 'default', fontWeight: '600' })}>
          Drag across the area where the subtitles appear
        </span>
        <button onClick={() => onSelect({ ...DEFAULT_OCR_REGION })} style={chip()}>
          Use bottom strip
        </button>
        <button onClick={onCancel} style={chip()}>
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}
