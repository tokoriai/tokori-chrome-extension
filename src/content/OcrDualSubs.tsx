/**
 * OCR-only dual-subtitle overlay — for sites whose subtitles are burned
 * into the video frames, with no caption track worth harvesting. First
 * site: bilibili.tv (BiliIntl), where hardcoded subs are the norm and
 * the player is MSE-fed like YouTube's, so canvas frame capture works.
 *
 * Reuses the YouTube OCR pipeline wholesale: content/ocr/useOcrCues
 * samples the user-drawn region, recognizes changed frames (local
 * tesseract pack or the user's AI key — Options → AI), assembles cues,
 * and translates each distinct line through the extension's `translate`
 * action. This surface just mounts a toolbar (toggle / region / status)
 * anchored to the player, follows playback, and renders the same
 * tokenized click-to-define caption pair the streaming overlay uses.
 *
 * OCR-only by design for now: bilibili.tv does offer closed captions on
 * some titles, but harvesting them needs a MAIN-world hook per player
 * generation — worth building only if burned-in OCR proves too lossy.
 */

import { useCallback, useEffect, useState } from 'react';
import { s, TOKENS } from '../lib/theme';
import { sendMsgAsync } from '../lib/chromeApi';
import { cueAt } from '../lib/subtitles';
import { segmentText, type Token } from './youtube/caption-tokenize';
import { RubyWord } from './RubyWord';
import { useOcrCues } from './ocr/useOcrCues';
import { OcrRegionSelector } from './ocr/OcrRegionSelector';
import {
  DEFAULT_OCR_REGION,
  normalizeOcrRegion,
  type OcrCue,
  type OcrRegion,
} from '../lib/ocr-cues';
import type { LanguageCode } from '../lib/languages';
import type { Settings } from '../lib/settings';

export interface OcrSiteConfig {
  /** Human name for tooltips and the toolbar pill. */
  name: string;
  hostRe: RegExp;
  /** Watch-page pathname test — the overlay renders nowhere else. */
  watchRe: RegExp;
  /** The site's player <video> element. */
  videoSelector: string;
  /** chrome.storage.local key for the saved capture region. */
  regionKey: string;
  /** Toggle-pill background while OCR is on. */
  accentOn: string;
}

const BILIBILI_TV: OcrSiteConfig = {
  name: 'bilibili.tv',
  hostRe: /(^|\.)bilibili\.tv$/,
  // /en/video/<id> and /en/play/<season>/<ep> — the locale prefix varies.
  watchRe: /\/(video|play)\//,
  videoSelector: 'video',
  regionKey: 'bilibiliTvOcrRegion',
  accentOn: 'rgba(0,161,214,0.85)',
};

export function BilibiliTvOcrSubs() {
  return <OcrDualSubs site={BILIBILI_TV} />;
}

function OcrDualSubs({ site }: { site: OcrSiteConfig }) {
  const onSite = typeof window !== 'undefined' && site.hostRe.test(window.location.hostname);

  // SPA navigation — bilibili.tv swaps pages client-side; poll the
  // pathname like the other site surfaces do.
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    if (!onSite) return;
    const timer = window.setInterval(() => {
      setPath((prev) => (window.location.pathname === prev ? prev : window.location.pathname));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onSite]);
  const onWatch = onSite && site.watchRe.test(path);

  /** OCR toggled on by the user — deliberately off on every page load:
   *  recognition can bill an AI key, so it never auto-starts. */
  const [enabled, setEnabled] = useState(false);
  const [region, setRegion] = useState<OcrRegion | null>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [targetLang, setTargetLang] = useState<LanguageCode>('zh');
  const [hovered, setHovered] = useState(false);
  const [videoRect, setVideoRect] = useState<DOMRect | null>(null);
  const [activeNative, setActiveNative] = useState<OcrCue | null>(null);
  const [activeTranslated, setActiveTranslated] = useState<OcrCue | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [readings, setReadings] = useState<Record<string, string | null>>({});

  // Target (workspace) language + the saved capture region.
  useEffect(() => {
    if (!onSite) return;
    void sendMsgAsync<{ data?: Settings }>({ action: 'getSettings' }).then((res) => {
      const st = (res as unknown as { data?: Settings }).data;
      if (st?.defaultTargetLang) setTargetLang(st.defaultTargetLang as LanguageCode);
    });
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !('defaultTargetLang' in changes)) return;
      const lang = changes.defaultTargetLang?.newValue as LanguageCode | undefined;
      if (lang) setTargetLang(lang);
    };
    try {
      chrome.storage.local.get([site.regionKey], (r) => {
        if (r[site.regionKey]) setRegion(normalizeOcrRegion(r[site.regionKey]));
      });
      chrome.storage.onChanged.addListener(onChanged);
    } catch {
      /* extension context gone — defaults serve */
    }
    return () => {
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch {}
    };
  }, [onSite, site.regionKey]);

  const ocr = useOcrCues(
    onWatch && enabled,
    targetLang,
    region ?? DEFAULT_OCR_REGION,
    true,
    site.videoSelector,
  );

  // First-ever enable: ask WHERE the subtitles are before burning
  // recognition calls on the wrong strip. Esc keeps the default bottom
  // strip; the ⛶ Region chip reopens the selector.
  useEffect(() => {
    if (enabled && region === null) setSelectingRegion(true);
    if (!enabled) setSelectingRegion(false);
  }, [enabled, region]);

  const saveRegion = (r: OcrRegion) => {
    setRegion(r);
    setSelectingRegion(false);
    try {
      chrome.storage.local.set({ [site.regionKey]: r });
    } catch {}
  };

  // Follow playback + the player rect in one RAF loop, exactly like the
  // streaming overlay (the rect also anchors the toolbar/captions).
  useEffect(() => {
    if (!onWatch) return;
    let raf = 0;
    const tick = () => {
      const video = document.querySelector<HTMLVideoElement>(site.videoSelector);
      const rect = video && video.videoWidth ? video.getBoundingClientRect() : null;
      setVideoRect((prev) => {
        if (!prev || !rect) return rect;
        return Math.abs(prev.left - rect.left) < 0.5 &&
          Math.abs(prev.top - rect.top) < 0.5 &&
          Math.abs(prev.width - rect.width) < 0.5 &&
          Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : rect;
      });
      const t = video?.currentTime ?? 0;
      setActiveNative((prev) => {
        const next = cueAt(ocr.native, t);
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      setActiveTranslated((prev) => {
        const next = cueAt(ocr.translated, t);
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onWatch, ocr.native, ocr.translated, site.videoSelector]);

  // Tokenize + readings for the active native line (same recipe as the
  // streaming overlay).
  const withRuby = targetLang === 'zh' || targetLang === 'ja';
  useEffect(() => {
    const text = activeNative?.text;
    if (!text) {
      setTokens([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const toks = await segmentText(text, targetLang);
      if (cancelled) return;
      setTokens(toks);
      if (!withRuby) return;
      const words = Array.from(
        new Set(toks.filter((t) => t.kind === 'word').map((t) => t.text)),
      ).slice(0, 120);
      const res = await sendMsgAsync<{ readings: Record<string, string | null> }>({
        action: 'dictReadings',
        lang: targetLang,
        words,
      });
      if (!cancelled && res.success) {
        setReadings((res as unknown as { readings: Record<string, string | null> }).readings ?? {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeNative?.text, targetLang, withRuby]);

  const clickWord = useCallback(
    (word: string, sentence: string, e: React.MouseEvent) => {
      window.dispatchEvent(
        new CustomEvent('tokori-show-dict', {
          detail: {
            query: word,
            sentence,
            lang: targetLang,
            anchor: { x: e.clientX, y: e.clientY },
            placement: 'above',
          },
        }),
      );
    },
    [targetLang],
  );

  if (!onWatch || !videoRect) return null;

  const pill = (extra?: object) =>
    s({
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '999px',
      padding: '3px 10px',
      fontSize: '11px',
      cursor: 'pointer',
      pointerEvents: 'auto',
      ...extra,
    });

  // Anchor opposite the capture region so the rendered captions never
  // cover the burned-in text they were read from.
  const r = region ?? DEFAULT_OCR_REGION;
  const captureIsLow = r.y + r.h / 2 > 0.5;
  const anchorY = captureIsLow
    ? videoRect.top + videoRect.height * 0.08
    : videoRect.top + videoRect.height * 0.74;

  return (
    <>
      {selectingRegion && (
        <OcrRegionSelector
          current={region}
          onSelect={saveRegion}
          onCancel={() => setSelectingRegion(false)}
          videoSelector={site.videoSelector}
        />
      )}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={s({
          position: 'fixed',
          left: `${videoRect.left + videoRect.width / 2}px`,
          top: `${anchorY}px`,
          transform: 'translateX(-50%)',
          maxWidth: `${Math.max(240, videoRect.width - 40)}px`,
          zIndex: '2147483645',
          pointerEvents: 'auto',
          textAlign: 'center',
        })}
      >
        <div
          style={s({
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '6px',
            // Off: stay visible as the affordance. On without a line
            // yet: the status chip is the feedback. Cues flowing:
            // reveal on hover only, the captions speak for themselves.
            opacity: hovered || !enabled || !activeNative ? 1 : 0,
            transition: 'opacity 120ms ease',
          })}
        >
          <button
            onClick={() => setEnabled((v) => !v)}
            style={pill({ background: enabled ? site.accentOn : 'rgba(0,0,0,0.7)' })}
            title={`Read ${site.name}'s burned-in (hardcoded) subtitles off the video frames — local model or AI key (Options → AI). Words become clickable, with a translation line underneath.`}
          >
            Tokori OCR {enabled ? 'on' : 'off'}
          </button>
          {enabled && (
            <button
              onClick={() => setSelectingRegion(true)}
              title="Choose where on the video the burned-in subtitles are — the OCR only reads that area"
              style={pill()}
            >
              ⛶ Region
            </button>
          )}
          {enabled && (
            <span
              title={
                ocr.error
                  ? `OCR problem — ${ocr.error}`
                  : 'Reading burned-in subtitles from the video frame; the translation line uses your translate engine.'
              }
              style={s({
                background: 'rgba(0,0,0,0.5)',
                color: ocr.error ? '#fbbf24' : TOKENS.textMuted,
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '999px',
                padding: '2px 8px',
                fontSize: '10px',
                cursor: 'help',
                pointerEvents: 'auto',
              })}
            >
              {ocr.error ? '⚠ OCR' : ocr.native.length > 0 ? 'OCR live' : 'OCR watching…'}
            </span>
          )}
        </div>

        {enabled && activeNative && (
          <div
            style={s({
              background: 'rgba(0,0,0,0.72)',
              borderRadius: '10px',
              padding: '8px 14px',
              display: 'inline-block',
            })}
          >
            <div style={s({ color: '#fff', fontSize: '26px', lineHeight: '1.5' })}>
              {tokens.map((t, i) =>
                t.kind === 'word' ? (
                  <span
                    key={i}
                    onClick={(e) => clickWord(t.text, activeNative.text, e)}
                    style={s({ cursor: 'pointer', borderRadius: '3px' })}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.18)')
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background = 'transparent')
                    }
                  >
                    {withRuby ? (
                      <RubyWord word={t.text} reading={readings[t.text]} lang={targetLang} />
                    ) : (
                      t.text
                    )}
                  </span>
                ) : (
                  <span key={i}>{t.text}</span>
                ),
              )}
            </div>
            {activeTranslated?.text && (
              <div style={s({ color: TOKENS.textMuted, fontSize: '15px', marginTop: '4px' })}>
                {activeTranslated.text}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
