/**
 * Dual-subtitle player — dedicated page (player.html).
 *
 * Load ANY video (a local file or a direct media URL) and study it
 * with the same dual-subtitle experience the YouTube overlay gives:
 * a tokenized, click-to-define target-language line (ruby readings
 * for zh/ja) over a translation line. Subtitles come from:
 *   - an SRT/VTT file per line (native + translation), or
 *   - auto-translation of the native cue (background `translate`), or
 *   - OCR of burned-in subtitles via the paired desktop's PaddleOCR
 *     (`POST /v1/ocr`) when the video has no subtitle track at all.
 *
 * Watching here counts: immersion beats stream to the background
 * exactly like the YouTube pill's (auto-started while the video
 * plays), so time lands in Stats/desktop — and URL-loaded videos that
 * are on the watch library advance their progress too (the beat
 * carries url + position + duration).
 */

import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, FileVideo, Captions, Languages, ScanText, Timer } from 'lucide-react';

import { sendMsg, sendMsgAsync } from '../lib/chromeApi';
import { initPageTheme, SHADOW_CSS } from '../lib/theme';
import { Button } from '../components/ui/button';
import { formatTimer } from '../lib/immersion';
import { parseSubtitles, cueAt, type SubtitleCue } from '../lib/subtitles';
import { segmentText, type Token } from '../content/youtube/caption-tokenize';
import { RubyWord } from '../content/RubyWord';
import { HoverPopup } from '../content/HoverPopup';
import type { LanguageCode } from '../lib/languages';
import { LANGUAGES } from '../lib/languages';
import type { Settings } from '../lib/settings';

import '../index.css';

initPageTheme();

const BEAT_FLUSH_MS = 10_000;
const OCR_INTERVAL_MS = 1200;
/** Bottom slice of the frame that burned-in subtitles live in. */
const OCR_BAND = 0.3;

type SubSource = { name: string; cues: SubtitleCue[] };

function PlayerPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  /** http(s) URL when loaded from a link — rides the immersion beats
   *  so a matching watch-library item advances. Local files have no
   *  stable identity, so they track time only. */
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [native, setNative] = useState<SubSource | null>(null);
  const [translated, setTranslated] = useState<SubSource | null>(null);
  const [lang, setLang] = useState<LanguageCode>('zh');
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [ocrOn, setOcrOn] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<{ base: string; token: string } | null>(null);
  const [timerMs, setTimerMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Session paused (organically or from the desktop sidebar) — the
   *  timer pill swaps its live dot for an amber one. */
  const [sessionPaused, setSessionPaused] = useState(false);

  // Settings: default target language + desktop pairing for OCR.
  useEffect(() => {
    sendMsg({ action: 'getSettings' }, (res) => {
      if (!res?.success) return;
      const s = (res as unknown as { data?: Settings }).data;
      if (!s) return;
      if (s.defaultTargetLang) setLang(s.defaultTargetLang as LanguageCode);
      if (s.localApi.token) {
        setDesktop({ base: s.localApi.baseUrl, token: s.localApi.token });
      }
    });
  }, []);

  // ── Cue tracking ──────────────────────────────────────────────
  const [nativeCue, setNativeCue] = useState<SubtitleCue | null>(null);
  const [translatedCue, setTranslatedCue] = useState<SubtitleCue | null>(null);
  /** OCR result shown in place of a native cue when OCR mode is on. */
  const [ocrText, setOcrText] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      const t = video.currentTime;
      setNativeCue((prev) => {
        const next = native ? cueAt(native.cues, t) : null;
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      setTranslatedCue((prev) => {
        const next = translated ? cueAt(translated.cues, t) : null;
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [native, translated]);

  // ── Auto-translate the native cue when no translation track ──
  const translateCache = useRef(new Map<string, string>());
  const [autoTranslation, setAutoTranslation] = useState<string | null>(null);
  const displayNativeText = ocrOn ? ocrText : (nativeCue?.text ?? null);
  useEffect(() => {
    setAutoTranslation(null);
    if (!autoTranslate || translated || !displayNativeText) return;
    const text = displayNativeText;
    const cached = translateCache.current.get(text);
    if (cached) {
      setAutoTranslation(cached);
      return;
    }
    let cancelled = false;
    sendMsg({ action: 'translate', text, from: lang, to: 'en' }, (res) => {
      if (cancelled || !res?.success) return;
      const tr = (res as unknown as { data?: { translation?: string } }).data?.translation;
      if (tr) {
        translateCache.current.set(text, tr);
        setAutoTranslation(tr);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [displayNativeText, autoTranslate, translated, lang]);

  // ── Immersion tracking: auto-start while playing ──────────────
  //
  // Desktop sync mirrors the YouTube hook: playing/paused edges flush
  // immediately (with a `playing` flag) so the desktop chip freezes
  // fast, a ~3 s control poll applies desktop-issued pause/resume to
  // the <video>, and a desktop End stops the session — auto-start
  // then stays suppressed until a fresh pause→play cycle, which reads
  // as new start intent.
  const pendingMsRef = useRef(0);
  const activeRef = useRef(false);
  /** Desktop-confirmed session pause — gates accrual (the count stops
   *  even if pausing the element failed) + drives the pill hint. */
  const sessionPausedRef = useRef(false);
  const remoteStoppedRef = useRef(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let last = Date.now();
    let sinceFlush = 0;
    let lastPlaying: boolean | null = null;

    const applyPaused = (paused: boolean) => {
      sessionPausedRef.current = paused;
      setSessionPaused(paused);
    };
    const sessionOver = () => {
      activeRef.current = false;
      applyPaused(false);
      remoteStoppedRef.current = true;
    };

    const beat = (extra?: { ended?: boolean; playing?: boolean; keepalive?: boolean }) => {
      const delta = pendingMsRef.current;
      pendingMsRef.current = 0;
      if (delta <= 0 && !extra?.ended && extra?.playing === undefined && !extra?.keepalive) return;
      sendMsg(
        {
          action: 'immersionBeat',
          deltaMs: delta,
          title: sourceName ?? 'Player',
          url: sourceUrl ?? window.location.href,
          positionSec: Math.round(video.currentTime) || undefined,
          durationSec: Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
          ended: extra?.ended || undefined,
          ...(extra?.playing === undefined ? {} : { playing: extra.playing }),
        },
        (res) => {
          const r = res as unknown as { success?: boolean; active?: boolean; paused?: boolean };
          if (r?.success && r.active === false && activeRef.current) sessionOver();
          else if (r?.success && typeof r.paused === 'boolean') applyPaused(r.paused);
        },
      );
    };
    const interval = window.setInterval(() => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      const isPlaying = !video.paused && !video.ended;
      // A pause after a desktop-side End re-arms the auto-start: the
      // next play is a fresh session, not the one the user just ended.
      if (remoteStoppedRef.current && !isPlaying) remoteStoppedRef.current = false;
      if (isPlaying && !activeRef.current && !remoteStoppedRef.current) {
        activeRef.current = true;
        applyPaused(false);
        lastPlaying = null;
        sendMsg(
          {
            action: 'immersionStart',
            title: sourceName ?? 'Player',
            url: sourceUrl ?? window.location.href,
          },
          () => {},
        );
      }
      if (activeRef.current) {
        let edge =
          lastPlaying === null
            ? isPlaying
              ? null
              : false
            : lastPlaying !== isPlaying
              ? isPlaying
              : null;
        // Pressing play under a desktop pause is an explicit resume.
        if (sessionPausedRef.current && isPlaying && lastPlaying === false) edge = true;
        lastPlaying = isPlaying;
        if (isPlaying && !sessionPausedRef.current) {
          pendingMsRef.current += delta;
          setTimerMs((ms) => ms + delta);
        }
        sinceFlush += delta;
        if (edge !== null) {
          sinceFlush = 0;
          beat({ playing: edge });
        } else if (sinceFlush >= BEAT_FLUSH_MS) {
          sinceFlush = 0;
          // Keepalive even while paused — the session (and the desktop
          // mirror) must outlive a coffee break.
          beat({ keepalive: true });
        }
      }
      setPlaying(isPlaying);
    }, 1000);
    // ~3 s poll for desktop-issued commands while a session runs.
    const poll = window.setInterval(() => {
      if (!activeRef.current) return;
      sendMsg({ action: 'immersionControlPoll' }, (res) => {
        const r = res as unknown as
          | {
              success?: boolean;
              active?: boolean;
              paused?: boolean;
              control?: 'pause' | 'resume' | null;
              endRequested?: boolean;
            }
          | undefined;
        if (!r?.success || !activeRef.current) return;
        if (r.active === false) {
          sessionOver();
          return;
        }
        if (r.endRequested) {
          // Desktop End — flush the tail, then close out.
          beat();
          sessionOver();
          sendMsg({ action: 'immersionStop', deltaMs: 0 }, () => {});
          return;
        }
        if (typeof r.paused === 'boolean') applyPaused(r.paused);
        if (r.control === 'pause') video.pause();
        else if (r.control === 'resume' && video.paused) void video.play().catch(() => {});
      });
    }, 3_000);
    const onEnded = () => beat({ ended: true });
    const onHide = () => beat();
    video.addEventListener('ended', onEnded);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(poll);
      video.removeEventListener('ended', onEnded);
      window.removeEventListener('pagehide', onHide);
      beat();
      if (activeRef.current) {
        activeRef.current = false;
        sendMsg({ action: 'immersionStop', deltaMs: 0 }, () => {});
      }
    };
  }, [sourceName, sourceUrl]);

  // ── OCR mode: sample the subtitle band via the desktop engine ──
  useEffect(() => {
    const video = videoRef.current;
    if (!ocrOn || !desktop || !video) return;
    setOcrError(null);
    let busy = false;
    let lastText = '';
    const canvas = document.createElement('canvas');
    const timer = window.setInterval(async () => {
      if (busy || video.paused || video.videoWidth === 0) return;
      busy = true;
      try {
        const scale = Math.min(1, 960 / video.videoWidth);
        const w = Math.round(video.videoWidth * scale);
        const bandH = Math.round(video.videoHeight * OCR_BAND * scale);
        canvas.width = w;
        canvas.height = bandH;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(
          video,
          0,
          video.videoHeight * (1 - OCR_BAND),
          video.videoWidth,
          video.videoHeight * OCR_BAND,
          0,
          0,
          w,
          bandH,
        );
        // Throws on CORS-tainted sources (remote URLs without CORS
        // headers) — surfaced once as a hint instead of spamming.
        const b64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]!;
        const res = await fetch(`${desktop.base}/v1/ocr`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${desktop.token}`,
          },
          body: JSON.stringify({ image_b64: b64, lang }),
        });
        if (!res.ok) throw new Error(`OCR failed (${res.status})`);
        const json = (await res.json()) as { lines?: string[] };
        const text = (json.lines ?? []).join(' ').trim();
        if (text && text !== lastText) {
          lastText = text;
          setOcrText(text);
        } else if (!text) {
          setOcrText(null);
        }
      } catch (e) {
        setOcrError(
          e instanceof Error && e.message.includes('insecure')
            ? 'This video source blocks frame capture (CORS) — OCR needs a local file or a CORS-enabled URL.'
            : e instanceof Error
              ? e.message
              : String(e),
        );
        setOcrOn(false);
      } finally {
        busy = false;
      }
    }, OCR_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ocrOn, desktop, lang]);

  // ── Loaders ───────────────────────────────────────────────────
  const loadVideoFile = useCallback((file: File) => {
    const video = videoRef.current;
    if (!video) return;
    video.src = URL.createObjectURL(file);
    setSourceName(file.name);
    setSourceUrl(null);
    setTimerMs(0);
  }, []);

  const loadVideoUrl = useCallback((url: string) => {
    const video = videoRef.current;
    const clean = url.trim();
    if (!video || !clean) return;
    video.src = clean;
    setSourceName(clean.split('/').pop() || clean);
    setSourceUrl(/^https?:/i.test(clean) ? clean : null);
    setTimerMs(0);
  }, []);

  const loadSubs = useCallback(async (file: File, slot: 'native' | 'translated') => {
    const cues = parseSubtitles(await file.text());
    const src = { name: file.name, cues };
    if (slot === 'native') setNative(cues.length ? src : null);
    else setTranslated(cues.length ? src : null);
  }, []);

  const translationLine = translated
    ? (translatedCue?.text ?? '')
    : autoTranslate
      ? (autoTranslation ?? '')
      : '';

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Popup styles (tone colors, ruby) — same sheet the content
          script injects into its shadow root. */}
      <style>{SHADOW_CSS}</style>
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-8 pb-24">
        <div className="flex items-center gap-3">
          <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-9" />
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Player</h1>
            <p className="text-sm text-muted-foreground">
              Any video + dual subtitles. Watching here tracks like YouTube.
            </p>
          </div>
          {timerMs > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs tabular-nums text-muted-foreground"
              title={
                sessionPaused
                  ? 'Immersion timer paused (video paused, or paused from the Tokori desktop sidebar) — play to resume'
                  : 'Immersion time tracked this session (auto-started while playing)'
              }
            >
              <Timer className="size-3.5" aria-hidden />
              {formatTimer(timerMs)}
              {sessionPaused ? (
                <span className="size-1.5 rounded-full bg-amber-500" />
              ) : (
                playing && <span className="size-1.5 rounded-full bg-emerald-500" />
              )}
            </span>
          )}
          <a
            href={chrome.runtime.getURL('library.html')}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Library
          </a>
        </div>

        <video ref={videoRef} controls className="aspect-video w-full rounded-xl bg-black" />

        {/* Dual-subtitle panel */}
        <div className="min-h-28 rounded-xl border bg-card px-5 py-4 text-center">
          <CueLine
            text={ocrOn ? ocrText : (nativeCue?.text ?? null)}
            lang={lang}
            placeholder={
              sourceName
                ? ocrOn
                  ? 'Watching for burned-in subtitles…'
                  : native
                    ? '…'
                    : 'Load a subtitle file (or turn on OCR for burned-in subs).'
                : 'Open a video to get started.'
            }
          />
          {translationLine ? (
            <p className="mt-2 text-sm text-muted-foreground">{translationLine}</p>
          ) : null}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <label>
            <input
              type="file"
              accept="video/*,audio/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && loadVideoFile(e.target.files[0])}
            />
            <Button asChild size="sm" variant="outline">
              <span className="cursor-pointer">
                <FileVideo data-icon="inline-start" />
                Open video
              </span>
            </Button>
          </label>
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadVideoUrl(urlDraft)}
            placeholder="…or paste a direct video URL and press Enter"
            className="h-8 w-64 rounded-md border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground"
          />
          <label title="Target-language subtitles (SRT / VTT)">
            <input
              type="file"
              accept=".srt,.vtt,text/vtt"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && void loadSubs(e.target.files[0], 'native')}
            />
            <Button asChild size="sm" variant="outline">
              <span className="cursor-pointer">
                <Captions data-icon="inline-start" />
                {native ? `Subs: ${native.name}` : 'Subtitles'}
              </span>
            </Button>
          </label>
          <label title="Translation subtitles (SRT / VTT) — optional; auto-translate covers the gap">
            <input
              type="file"
              accept=".srt,.vtt,text/vtt"
              className="hidden"
              onChange={(e) =>
                e.target.files?.[0] && void loadSubs(e.target.files[0], 'translated')
              }
            />
            <Button asChild size="sm" variant="outline">
              <span className="cursor-pointer">
                <Languages data-icon="inline-start" />
                {translated ? `Translation: ${translated.name}` : 'Translation'}
              </span>
            </Button>
          </label>
          <Button
            size="sm"
            variant={autoTranslate && !translated ? 'default' : 'outline'}
            onClick={() => setAutoTranslate((v) => !v)}
            disabled={!!translated}
            title="Translate each subtitle line on the fly (desktop AI or free engine)"
          >
            Auto-translate {autoTranslate && !translated ? 'on' : 'off'}
          </Button>
          <Button
            size="sm"
            variant={ocrOn ? 'default' : 'outline'}
            onClick={() => setOcrOn((v) => !v)}
            disabled={!desktop}
            title={
              desktop
                ? 'Recognize subtitles burned into the video frames via the Tokori desktop OCR'
                : 'Pair the Tokori desktop app to enable burned-in subtitle OCR'
            }
          >
            <ScanText data-icon="inline-start" />
            OCR subs {ocrOn ? 'on' : 'off'}
          </Button>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value as LanguageCode)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            title="Subtitle language — drives tokenization, readings, and OCR"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>

        {ocrError && <p className="text-xs text-amber-700 dark:text-amber-400">{ocrError}</p>}
        {!sourceName && (
          <div className="rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
            <Clapperboard className="mx-auto mb-2 size-6" aria-hidden />
            Open a local video file (nothing is uploaded — it plays right here) or paste a direct
            media URL. Add an SRT/VTT for the target language; the translation line fills itself.
            Words are clickable, exactly like the YouTube captions.
          </div>
        )}
      </div>

      {/* Click-to-define popup — the same component the content script
          mounts; it listens for text selection and the tokori-show-dict
          event our cue words dispatch. */}
      <HoverPopup />
    </div>
  );
}

/** Tokenized, clickable subtitle line with ruby readings — the page
 *  cousin of the YouTube overlay's native row. */
function CueLine({
  text,
  lang,
  placeholder,
}: {
  text: string | null;
  lang: LanguageCode;
  placeholder: string;
}) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [readings, setReadings] = useState<Record<string, string | null>>({});
  const withRuby = lang === 'zh' || lang === 'ja';

  useEffect(() => {
    if (!text) {
      setTokens([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const toks = await segmentText(text, lang);
      if (cancelled) return;
      setTokens(toks);
      if (!withRuby) return;
      const words = Array.from(
        new Set(toks.filter((t) => t.kind === 'word').map((t) => t.text)),
      ).slice(0, 120);
      const res = await sendMsgAsync<{ readings: Record<string, string | null> }>({
        action: 'dictReadings',
        lang,
        words,
      });
      if (!cancelled && res.success) {
        setReadings((res as unknown as { readings: Record<string, string | null> }).readings ?? {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, lang, withRuby]);

  if (!text) {
    return <p className="py-3 text-sm text-muted-foreground">{placeholder}</p>;
  }
  return (
    <p className="text-2xl leading-relaxed">
      {tokens.map((t, i) =>
        t.kind === 'word' ? (
          <button
            key={i}
            type="button"
            className="rounded-sm px-0.5 transition-colors hover:bg-accent"
            onClick={(e) => {
              window.dispatchEvent(
                new CustomEvent('tokori-show-dict', {
                  detail: {
                    query: t.text,
                    sentence: text,
                    lang,
                    anchor: { x: e.clientX, y: e.clientY },
                    placement: 'above',
                  },
                }),
              );
            }}
          >
            {withRuby ? <RubyWord word={t.text} reading={readings[t.text]} lang={lang} /> : t.text}
          </button>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </p>
  );
}

createRoot(document.getElementById('root')!).render(<PlayerPage />);
