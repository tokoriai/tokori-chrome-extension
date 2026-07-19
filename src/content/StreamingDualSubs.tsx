/**
 * Streaming-site dual-subtitle overlay — the ISOLATED-world consumer
 * shared by every "MAIN-world harvester + event contract" site
 * (Netflix via netflix-cues.ts, Disney+ via disney-cues.ts).
 *
 * Renders a tokenized, click-to-define target-language line over a
 * translation line, replacing the site's own subtitle display while
 * active (hidden via an injected style so the two never stack).
 * Clicking a word drives the same HoverPopup the rest of the
 * extension uses.
 *
 * Experimental by nature: each harvester rides its site's private
 * manifest/playlist shape, which shifts under A/B tests. Everything
 * fails soft — if no tracks are harvested the overlay simply never
 * appears and the site's own subtitles are left untouched.
 *
 * Event contract (`<prefix>` = site.eventPrefix):
 *   MAIN → content: `<prefix>-tracks` {movieId|contentId, tracks:[{id,language,label}]}
 *                   `<prefix>-native-cues` / `<prefix>-translated-cues` {cues}
 *   content → MAIN: `<prefix>-request-tracks`, `<prefix>-select` {slot, id|null}
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { s, TOKENS } from '../lib/theme';
import { sendMsgAsync } from '../lib/chromeApi';
import { cueAt, type SubtitleCue } from '../lib/subtitles';
import { segmentText, type Token } from './youtube/caption-tokenize';
import { RubyWord } from './RubyWord';
import type { LanguageCode } from '../lib/languages';
import type { Settings } from '../lib/settings';

interface StreamingTrackInfo {
  id: string;
  language: string;
  label: string;
}

export interface StreamingSiteConfig {
  /** Human name for tooltips ("Netflix's own subtitles come back…"). */
  name: string;
  hostRe: RegExp;
  /** Watch-page pathname test — the overlay renders nowhere else. */
  watchRe: RegExp;
  /** CustomEvent name prefix shared with the MAIN-world harvester. */
  eventPrefix: string;
  /** Injected-style id + CSS hiding the site's own subtitle layer. */
  hideStyleId: string;
  hideCss: string;
  /** Toggle-pill background while the overlay is on. */
  accentOn: string;
}

const NETFLIX_SITE: StreamingSiteConfig = {
  name: 'Netflix',
  hostRe: /(^|\.)netflix\.com$/,
  watchRe: /\/watch\//,
  eventPrefix: 'tokori-nf',
  hideStyleId: 'tokori-nf-hide-native-subs',
  hideCss: '.player-timedtext{display:none!important;}',
  accentOn: 'rgba(223,75,31,0.35)',
};

const DISNEY_SITE: StreamingSiteConfig = {
  name: 'Disney+',
  hostRe: /(^|\.)disneyplus\.com$/,
  watchRe: /\/(?:play|video)\//,
  eventPrefix: 'tokori-dp',
  // Both subtitle-renderer generations; selectors fail soft (worst
  // case the user turns Disney's own subs off in its audio menu —
  // ours don't depend on them being on).
  hideStyleId: 'tokori-dp-hide-native-subs',
  hideCss:
    '.dss-subtitle-renderer-wrapper,.hive-subtitle-renderer-wrapper{display:none!important;}',
  accentOn: 'rgba(2,110,231,0.45)',
};

export function NetflixEnhancer() {
  return <StreamingDualSubs site={NETFLIX_SITE} />;
}

export function DisneyPlusEnhancer() {
  return <StreamingDualSubs site={DISNEY_SITE} />;
}

function StreamingDualSubs({ site }: { site: StreamingSiteConfig }) {
  const onSite = typeof window !== 'undefined' && site.hostRe.test(window.location.hostname);
  const ev = (suffix: string) => `${site.eventPrefix}-${suffix}`;

  const [enabled, setEnabled] = useState(true);
  const [tracks, setTracks] = useState<StreamingTrackInfo[]>([]);
  const [contentId, setContentId] = useState('');
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [translatedId, setTranslatedId] = useState<string | null>(null);
  const [nativeCues, setNativeCues] = useState<SubtitleCue[]>([]);
  const [translatedCues, setTranslatedCues] = useState<SubtitleCue[]>([]);
  const [activeNative, setActiveNative] = useState<SubtitleCue | null>(null);
  const [activeTranslated, setActiveTranslated] = useState<SubtitleCue | null>(null);
  const [targetLang, setTargetLang] = useState<LanguageCode>('zh');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [readings, setReadings] = useState<Record<string, string | null>>({});
  const autoPickedRef = useRef('');

  // Track + cue events from the MAIN-world harvester.
  useEffect(() => {
    if (!onSite) return;
    const onTracks = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        movieId?: string;
        contentId?: string;
        tracks: StreamingTrackInfo[];
      };
      setContentId(d.movieId ?? d.contentId ?? '');
      setTracks(d.tracks ?? []);
    };
    const onNative = (e: Event) =>
      setNativeCues(((e as CustomEvent).detail as { cues: SubtitleCue[] }).cues ?? []);
    const onTranslated = (e: Event) =>
      setTranslatedCues(((e as CustomEvent).detail as { cues: SubtitleCue[] }).cues ?? []);
    window.addEventListener(ev('tracks'), onTracks);
    window.addEventListener(ev('native-cues'), onNative);
    window.addEventListener(ev('translated-cues'), onTranslated);
    window.dispatchEvent(new CustomEvent(ev('request-tracks')));
    void sendMsgAsync<{ data?: Settings }>({ action: 'getSettings' }).then((res) => {
      const st = (res as unknown as { data?: Settings }).data;
      if (st?.defaultTargetLang) setTargetLang(st.defaultTargetLang as LanguageCode);
    });
    return () => {
      window.removeEventListener(ev('tracks'), onTracks);
      window.removeEventListener(ev('native-cues'), onNative);
      window.removeEventListener(ev('translated-cues'), onTranslated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSite]);

  // Auto-pick tracks once per title: target language for the native
  // line, English for the translation. The selects below override.
  useEffect(() => {
    if (!contentId || tracks.length === 0 || autoPickedRef.current === contentId) return;
    autoPickedRef.current = contentId;
    const byLang = (lang: string) =>
      tracks.find((t) => t.language.toLowerCase().startsWith(lang))?.id ?? null;
    setNativeId(byLang(targetLang));
    setTranslatedId(byLang('en'));
  }, [contentId, tracks, targetLang]);

  // Selection → ask MAIN world to fetch + parse the track.
  useEffect(() => {
    if (!onSite) return;
    window.dispatchEvent(
      new CustomEvent(ev('select'), { detail: { slot: 'native', id: nativeId } }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSite, nativeId, contentId]);
  useEffect(() => {
    if (!onSite) return;
    window.dispatchEvent(
      new CustomEvent(ev('select'), { detail: { slot: 'translated', id: translatedId } }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSite, translatedId, contentId]);

  // Follow playback.
  useEffect(() => {
    if (!onSite) return;
    let raf = 0;
    const tick = () => {
      const video = document.querySelector<HTMLVideoElement>('video');
      const t = video?.currentTime ?? 0;
      setActiveNative((prev) => {
        const next = cueAt(nativeCues, t);
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      setActiveTranslated((prev) => {
        const next = cueAt(translatedCues, t);
        return prev === next || (prev && next && prev.start === next.start) ? prev : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onSite, nativeCues, translatedCues]);

  // Tokenize + readings for the active native line.
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

  // Hide the site's own subtitle layer while our overlay owns the job.
  const showing = onSite && enabled && nativeId != null && nativeCues.length > 0;
  useEffect(() => {
    if (!onSite) return;
    let styleEl = document.getElementById(site.hideStyleId) as HTMLStyleElement | null;
    if (showing && !styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = site.hideStyleId;
      styleEl.textContent = site.hideCss;
      document.head.appendChild(styleEl);
    } else if (!showing && styleEl) {
      styleEl.remove();
    }
    return () => {
      document.getElementById(site.hideStyleId)?.remove();
    };
  }, [onSite, showing, site.hideStyleId, site.hideCss]);

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

  // Nothing harvested (or not a watch page) → render nothing.
  if (!onSite || tracks.length === 0 || !site.watchRe.test(window.location.pathname)) {
    return null;
  }

  const pill = (extra?: object) =>
    s({
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '999px',
      padding: '3px 10px',
      fontSize: '11px',
      ...extra,
    });

  return (
    <div
      style={s({
        position: 'fixed',
        left: '50%',
        bottom: '9%',
        transform: 'translateX(-50%)',
        maxWidth: '86vw',
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
        })}
      >
        <button
          onClick={() => setEnabled((v) => !v)}
          style={pill({
            cursor: 'pointer',
            background: enabled ? site.accentOn : 'rgba(0,0,0,0.7)',
          })}
          title={`Toggle Tokori dual subtitles (${site.name}'s own subtitles come back when off)`}
        >
          Tokori CC {enabled ? 'on' : 'off'}
        </button>
        <label style={pill({ display: 'inline-flex', gap: '4px', alignItems: 'center' })}>
          <span style={{ opacity: 0.7 }}>Native</span>
          <select
            value={nativeId ?? ''}
            onChange={(e) => setNativeId(e.target.value || null)}
            style={s({
              background: 'transparent',
              color: '#fff',
              border: 'none',
              fontSize: '11px',
              maxWidth: '130px',
            })}
          >
            <option value="" style={{ background: '#111' }}>
              —
            </option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id} style={{ background: '#111' }}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label style={pill({ display: 'inline-flex', gap: '4px', alignItems: 'center' })}>
          <span style={{ opacity: 0.7 }}>Translation</span>
          <select
            value={translatedId ?? ''}
            onChange={(e) => setTranslatedId(e.target.value || null)}
            style={s({
              background: 'transparent',
              color: '#fff',
              border: 'none',
              fontSize: '11px',
              maxWidth: '130px',
            })}
          >
            <option value="" style={{ background: '#111' }}>
              —
            </option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id} style={{ background: '#111' }}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
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
  );
}
