/**
 * YouTube caption sidebar — full-transcript panel.
 *
 * Docks into YouTube's own right-hand column (`#secondary`, where the
 * related-videos list lives) via a React portal so it sits next to the
 * video like the native transcript panel. In theater mode we shrink
 * YouTube's full-bleed player container and sit in the freed right
 * gutter — the same arrangement YT's own live chat uses, so the panel
 * is BESIDE the video, not over it. Fullscreen overlays the right edge
 * asbplayer-style instead (there is no "beside" in fullscreen; our
 * shadow root hangs off <html>, which is YouTube's fullscreen element,
 * so fixed positioning keeps working there). Layouts without a
 * secondary column fall back to a floating panel at the window edge.
 *
 * Shows every captured cue for the current video (native line +
 * translated line when available). The row whose time range contains
 * the playhead is highlighted and kept in view ("follow" mode — a
 * manual scroll pauses following until the user re-enables it).
 *
 * Interactions:
 *   • Click a row        → seek the video to that cue.
 *   • Row hover actions  → open the sentence analyzer, or seek + open
 *                          the mining modal for that cue.
 *   • Active-row words   → the currently-playing row renders the same
 *                          clickable tokens as the overlay; clicking
 *                          one fires `tokori-show-dict` for a lookup.
 *
 * Cues arrive via the same MAIN-world capture the overlay uses — the
 * enhancer owns the state and passes it down, so this component has no
 * event-listener plumbing of its own.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOKENS, TK_DARK_VARS, s } from '../../lib/theme';
import { detectLanguage, type LanguageCode } from '../../lib/languages';
import type { Token } from './caption-tokenize';
import { RubyWord } from '../RubyWord';

export interface SidebarCue {
  start: number;
  dur: number;
  text: string;
}

const DOCK_HOST_ID = 'tokori-caption-panel';
const THEATER_PANEL_PX = 346;

/** Maintain a host <div> prepended to YouTube's secondary column while
 *  the sidebar is open. Returns null when there's nothing to dock into
 *  (caller falls back to the floating layout). Re-attaches when a SPA
 *  navigation rebuilds the column and drops our node. */
function useDockHost(open: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      setHost(null);
      return;
    }
    let node: HTMLElement | null = null;
    const ensure = () => {
      if (node && node.isConnected) return;
      const existing = document.getElementById(DOCK_HOST_ID);
      if (existing?.isConnected) {
        node = existing as HTMLElement;
        setHost(node);
        return;
      }
      const secondary = document.querySelector<HTMLElement>('#secondary-inner, #secondary');
      if (!secondary) {
        node = null;
        setHost(null);
        return;
      }
      node = document.createElement('div');
      node.id = DOCK_HOST_ID;
      // The portal target lives outside our shadow root, so the theme
      // variables the panel's inline styles reference must be set here.
      // The panel stays dark next to the player regardless of OS theme.
      node.style.cssText = TK_DARK_VARS;
      secondary.prepend(node);
      setHost(node);
    };
    ensure();
    const iv = window.setInterval(ensure, 1500);
    return () => {
      window.clearInterval(iv);
      node?.remove();
      setHost(null);
    };
  }, [open]);
  return host;
}

/** Pair each native cue with the translated cue that starts closest to
 *  it (within a tolerance) — the two tracks come from the same
 *  timedtext timeline so starts line up almost exactly. */
function pairTranslations(native: SidebarCue[], translated: SidebarCue[]) {
  const out = new Map<number, string>();
  if (!translated.length) return out;
  let j = 0;
  for (const cue of native) {
    while (j < translated.length - 1 && translated[j + 1].start <= cue.start + 0.75) j++;
    const cand = translated[j];
    if (cand && Math.abs(cand.start - cue.start) < 1.5) out.set(cue.start, cand.text);
  }
  return out;
}

function formatTime(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function seekTo(sec: number) {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video) video.currentTime = sec + 0.01;
}

/** Seek to the cue, then open the miner once the RAF loop has had a
 *  frame or two to promote it to the active cue (the mining source
 *  getter reads the active cue at open time). */
function mineCue(cue: SidebarCue) {
  seekTo(cue.start);
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('tokori-open-miner')), 180);
}

export function CaptionSidebar({
  open,
  onClose,
  native,
  translated,
  activeStart,
  activeTokens,
  targetLang,
  theater,
  fullscreen,
  playerRect,
  colorFor,
  highlightMode = 'underline',
  showReading = false,
  readingFor = () => null,
  onToggleReading,
}: {
  open: boolean;
  onClose: () => void;
  native: SidebarCue[];
  translated: SidebarCue[];
  activeStart: number | null;
  /** Tokenised form of the active cue (from the enhancer's jieba /
   *  Segmenter pipeline), or null when no cue is live. */
  activeTokens: Token[] | null;
  targetLang: LanguageCode | null;
  /** Theater / fullscreen flags mirrored from ytd-watch-flexy. */
  theater: boolean;
  fullscreen: boolean;
  /** Player bounding rect (viewport coords) — the theater layout pins
   *  the panel to its right edge and matches its height. */
  playerRect: DOMRect | null;
  /** Vocab-status underline colour for a word (same mapping as the
   *  video overlay); null → neutral underline. */
  colorFor: (word: string) => string | null;
  /** Mirrors the overlay's caption style: coloured underline vs
   *  colouring the characters themselves. */
  highlightMode?: 'underline' | 'text';
  /** Ruby readings (pinyin / furigana) over the active row's tokens —
   *  shares the overlay's toggle + reading cache. */
  showReading?: boolean;
  readingFor?: (word: string) => string | null;
  onToggleReading?: () => void;
}) {
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Blur the translated line under each cue until the user clicks it —
   *  the sidebar twin of the overlay's "Blur EN". Persisted separately
   *  so reading-along and spot-checking can be tuned independently. */
  const [blurEn, setBlurEn] = useState(true);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  useEffect(() => {
    try {
      chrome.storage.local.get('youtubeSidebarBlurEn', (r) => {
        if (typeof r.youtubeSidebarBlurEn === 'boolean') setBlurEn(r.youtubeSidebarBlurEn);
      });
    } catch {
      /* extension context invalidated — keep default */
    }
  }, []);
  const toggleBlurEn = () => {
    setBlurEn((prev) => {
      const next = !prev;
      try {
        chrome.storage.local.set({ youtubeSidebarBlurEn: next });
      } catch {}
      return next;
    });
    setRevealed(new Set());
  };
  // Layouts: default view docks into #secondary; theater squeezes the
  // player and sits beside it (live-chat style); fullscreen lays the
  // panel over the video's right edge — asbplayer-style.
  const layout = fullscreen || theater ? 'drawer' : 'dock';
  const dockHost = useDockHost(open && layout === 'dock');

  // Theater "beside" mode: shrink YouTube's full-bleed player container
  // so the panel gets a real gutter instead of covering the video —
  // exactly what YT's own live chat does in theater. Inline styles win
  // over YT's stylesheet and are restored on close/unmount. The synthetic
  // resize nudges the player's internal sizing logic both ways. Falls
  // back to the overlay drawer when the container isn't found.
  const [besideGap, setBesideGap] = useState(false);
  useEffect(() => {
    if (!(open && theater && !fullscreen)) {
      setBesideGap(false);
      return;
    }
    const el = document.querySelector<HTMLElement>('#full-bleed-container');
    if (!el) {
      setBesideGap(false);
      return;
    }
    const prevWidth = el.style.width;
    const prevMaxWidth = el.style.maxWidth;
    const gapped = `calc(100% - ${THEATER_PANEL_PX + 16}px)`;
    el.style.width = gapped;
    el.style.maxWidth = gapped;
    setBesideGap(true);
    window.dispatchEvent(new Event('resize'));
    return () => {
      el.style.width = prevWidth;
      el.style.maxWidth = prevMaxWidth;
      setBesideGap(false);
      window.dispatchEvent(new Event('resize'));
    };
  }, [open, theater, fullscreen]);
  const translationByStart = useMemo(
    () => pairTranslations(native, translated),
    [native, translated],
  );

  // Keep the active row in view. `block: 'nearest'` avoids yanking the
  // whole list when the row is already visible.
  useEffect(() => {
    if (!open || !follow || activeStart == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cue-start="${activeStart}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open, follow, activeStart]);

  if (!open) return null;

  const lookupWord = (text: string, lang: LanguageCode, evt: React.MouseEvent) => {
    evt.stopPropagation();
    const rect = (evt.currentTarget as HTMLElement).getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent('tokori-show-dict', {
        detail: {
          query: text,
          lang,
          anchor: { x: rect.left, y: rect.bottom + 6 },
          placement: 'below',
        },
      }),
    );
  };

  const docked = layout === 'dock' && !!dockHost;
  // Drawer geometry. Two flavours:
  //   • Theater with the gap applied → the player has been narrowed, so
  //     pin the panel in the freed right gutter, flush with the
  //     player's vertical extent (live-chat look).
  //   • Fullscreen (or theater where #full-bleed-container wasn't
  //     found) → overlay the player's right edge, asbplayer-style. In
  //     fullscreen the player rect IS the viewport.
  // Both clamp to the viewport so a scrolled page doesn't push the
  // panel off-screen.
  let drawerPos: { left: number; top: number; height: number } | null = null;
  if (layout === 'drawer' && playerRect) {
    if (besideGap) {
      const top = Math.max(playerRect.top, 8);
      const bottom = Math.min(playerRect.bottom, window.innerHeight - 8);
      drawerPos = {
        left: window.innerWidth - THEATER_PANEL_PX - 8,
        top,
        height: Math.max(160, bottom - top),
      };
    } else {
      const top = Math.max(playerRect.top + 12, 8);
      const bottom = Math.min(playerRect.bottom - 12, window.innerHeight - 8);
      drawerPos = {
        left: playerRect.right - THEATER_PANEL_PX - 12,
        top,
        height: Math.max(160, bottom - top),
      };
    }
  }
  const panel = (
    <div
      className="tk-force-dark"
      onWheel={() => setFollow(false)}
      style={s({
        ...(docked
          ? {
              position: 'relative',
              width: '100%',
              height: 'min(72vh, 600px)',
              marginBottom: '16px',
              // The portal target lives in YouTube's light/dark page, not
              // our shadow root — set an explicit stacking context so the
              // dict popup (fixed, in the shadow root) still wins.
              zIndex: '10',
            }
          : drawerPos
            ? {
                position: 'fixed',
                left: `${drawerPos.left}px`,
                top: `${drawerPos.top}px`,
                height: `${drawerPos.height}px`,
                width: `${THEATER_PANEL_PX}px`,
                zIndex: '2147483644',
              }
            : {
                position: 'fixed',
                top: '64px',
                right: '12px',
                bottom: '12px',
                width: '340px',
                zIndex: '2147483644',
              }),
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(15,17,21,0.97)',
        color: TOKENS.text,
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '12px',
        boxShadow: docked ? '0 4px 16px rgba(0,0,0,0.35)' : '0 12px 32px rgba(0,0,0,0.55)',
        pointerEvents: 'auto',
        fontSize: '13px',
        overflow: 'hidden',
        boxSizing: 'border-box',
        textAlign: 'left',
        fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif',
      })}
    >
      <div
        style={s({
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        })}
      >
        <strong
          style={s({
            fontSize: '12px',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: TOKENS.textMuted,
          })}
        >
          Captions
        </strong>
        <span style={s({ color: TOKENS.textMuted, fontSize: '11px' })}>{native.length}</span>
        <span style={{ flex: 1 }} />
        {onToggleReading && (
          <button
            onClick={onToggleReading}
            title={
              showReading
                ? 'Hide readings (pinyin / furigana) on the active line'
                : 'Show readings (pinyin / furigana) on the active line'
            }
            style={s({
              background: showReading ? 'rgba(255,255,255,0.14)' : 'transparent',
              color: showReading ? '#fff' : TOKENS.textMuted,
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '999px',
              padding: '2px 9px',
              fontSize: '11px',
              cursor: 'pointer',
            })}
          >
            拼
          </button>
        )}
        <button
          onClick={toggleBlurEn}
          title={
            blurEn
              ? 'Translations are blurred — click a line to reveal it'
              : 'Translations are always visible'
          }
          style={s({
            background: blurEn ? 'rgba(255,255,255,0.14)' : 'transparent',
            color: blurEn ? '#fff' : TOKENS.textMuted,
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '999px',
            padding: '2px 9px',
            fontSize: '11px',
            cursor: 'pointer',
          })}
        >
          EN
        </button>
        {!follow && (
          <button
            onClick={() => setFollow(true)}
            title="Resume auto-scroll to the current caption"
            style={s({
              background: 'rgba(255,255,255,0.08)',
              color: TOKENS.accent,
              border: `1px solid ${TOKENS.accent}`,
              borderRadius: '999px',
              padding: '2px 10px',
              fontSize: '11px',
              cursor: 'pointer',
            })}
          >
            Follow
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close captions sidebar"
          style={s({
            background: 'transparent',
            border: 'none',
            color: TOKENS.textMuted,
            fontSize: '16px',
            lineHeight: '1',
            cursor: 'pointer',
            padding: '0 2px',
          })}
        >
          ×
        </button>
      </div>

      <div
        ref={listRef}
        style={s({
          flex: 1,
          overflowY: 'auto',
          padding: '6px 0',
          // Modern, light scrollbar — thin track, translucent thumb.
          // Standard properties, so they work both in the shadow root
          // and in the #secondary portal without a stylesheet.
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.22) transparent',
          overscrollBehavior: 'contain',
        })}
      >
        {native.length === 0 && (
          <div style={s({ color: TOKENS.textMuted, padding: '18px 14px', lineHeight: '1.5' })}>
            No captions captured yet. Play the video with CC enabled — cues appear here as soon as
            the track loads.
          </div>
        )}
        {native.map((cue, cueIndex) => {
          const isActive = cue.start === activeStart;
          const lang = detectLanguage(cue.text) || targetLang;
          const tr = translationByStart.get(cue.start);
          return (
            <CueRow
              key={cue.start}
              cue={cue}
              cueIndex={cueIndex}
              allCues={native}
              lang={lang}
              translation={tr}
              isActive={isActive}
              tokens={isActive ? activeTokens : null}
              onLookup={lookupWord}
              colorFor={colorFor}
              highlightMode={highlightMode}
              readingFor={showReading ? readingFor : undefined}
              blurTranslation={blurEn && !revealed.has(cue.start)}
              onRevealTranslation={() =>
                setRevealed((prev) => {
                  const next = new Set(prev);
                  next.add(cue.start);
                  return next;
                })
              }
            />
          );
        })}
      </div>
    </div>
  );

  return dockHost ? createPortal(panel, dockHost) : panel;
}

function CueRow({
  cue,
  cueIndex,
  allCues,
  lang,
  translation,
  isActive,
  tokens,
  onLookup,
  colorFor,
  highlightMode,
  readingFor,
  blurTranslation,
  onRevealTranslation,
}: {
  cue: SidebarCue;
  /** Position + full list — forwarded to the analyzer so its ‹ › pager
   *  can step through neighbouring lines. */
  cueIndex: number;
  allCues: SidebarCue[];
  lang: LanguageCode | null;
  translation?: string;
  isActive: boolean;
  tokens: Token[] | null;
  onLookup: (text: string, lang: LanguageCode, evt: React.MouseEvent) => void;
  colorFor: (word: string) => string | null;
  highlightMode: 'underline' | 'text';
  /** When set, active-row tokens get their reading as ruby on top. */
  readingFor?: (word: string) => string | null;
  blurTranslation: boolean;
  onRevealTranslation: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div
      data-cue-start={cue.start}
      onClick={() => seekTo(cue.start)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={s({
        padding: '7px 12px 7px 9px',
        borderLeft: `3px solid ${isActive ? TOKENS.accent : 'transparent'}`,
        background: isActive
          ? 'rgba(255,255,255,0.06)'
          : hovered
            ? 'rgba(255,255,255,0.03)'
            : 'transparent',
        cursor: 'pointer',
        transition: 'background 100ms ease',
      })}
    >
      <div style={s({ display: 'flex', alignItems: 'baseline', gap: '8px' })}>
        <span
          style={s({
            color: isActive ? TOKENS.accent : TOKENS.textMuted,
            fontSize: '11px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            flexShrink: '0',
          })}
        >
          {formatTime(cue.start)}
        </span>
        <span style={{ flex: 1 }} />
        {hovered && lang && (
          <span style={s({ display: 'inline-flex', gap: '6px', flexShrink: '0' })}>
            <RowAction
              label={copied ? 'copied ✓' : 'copy'}
              title="Copy this line (with translation) to the clipboard"
              onClick={(e) => {
                e.stopPropagation();
                const payload = translation ? `${cue.text}\n${translation}` : cue.text;
                navigator.clipboard
                  ?.writeText(payload)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  })
                  .catch(() => {});
              }}
            />
            <RowAction
              label="analyze"
              title="Open sentence analyzer"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent('tokori-open-analyzer', {
                    detail: {
                      text: cue.text,
                      lang,
                      cues: allCues.map((c) => ({ text: c.text, start: c.start })),
                      index: cueIndex,
                    },
                  }),
                );
              }}
            />
            <RowAction
              label="⛏ mine"
              title="Seek here and mine this sentence"
              onClick={(e) => {
                e.stopPropagation();
                mineCue(cue);
              }}
            />
          </span>
        )}
      </div>
      <div
        style={s({
          lineHeight:
            isActive && readingFor && tokens?.some((t) => readingFor(t.text)) ? '2' : '1.5',
          wordBreak: 'break-word',
          marginTop: '2px',
        })}
      >
        {isActive && tokens && lang
          ? tokens.map((tok, i) => {
              if (tok.kind === 'space') return <span key={i}>{tok.text}</span>;
              const ruby = readingFor ? readingFor(tok.text) : null;
              return (
                <span
                  key={i}
                  onClick={(e) => onLookup(tok.text, lang, e)}
                  style={s({
                    cursor: 'pointer',
                    borderRadius: '3px',
                    padding: '0 1px',
                    ...(highlightMode === 'text'
                      ? { color: colorFor(tok.text) || undefined }
                      : {
                          textDecoration: 'underline',
                          textDecorationThickness: '2px',
                          textDecorationColor: colorFor(tok.text) || 'rgba(255,255,255,0.25)',
                          textUnderlineOffset: '3px',
                        }),
                  })}
                >
                  {ruby ? <RubyWord word={tok.text} reading={ruby} lang={lang} /> : tok.text}
                </span>
              );
            })
          : cue.text}
      </div>
      {translation && (
        <div
          title={blurTranslation ? 'Click to reveal the translation' : undefined}
          onClick={(e) => {
            if (!blurTranslation) return;
            // Reveal without seeking — the row's own click handler jumps
            // the video, which is not what a peek at the answer means.
            e.stopPropagation();
            onRevealTranslation();
          }}
          style={s({
            color: TOKENS.textMuted,
            fontSize: '12px',
            lineHeight: '1.4',
            marginTop: '2px',
            wordBreak: 'break-word',
            filter: blurTranslation ? 'blur(4px)' : 'none',
            cursor: blurTranslation ? 'pointer' : 'inherit',
            userSelect: blurTranslation ? 'none' : 'text',
            transition: 'filter 150ms ease',
          })}
        >
          {translation}
        </div>
      )}
    </div>
  );
}

function RowAction({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={title}
      style={s({
        background: 'rgba(255,255,255,0.08)',
        color: TOKENS.accent,
        border: 'none',
        borderRadius: '4px',
        padding: '1px 7px',
        fontSize: '11px',
        cursor: 'pointer',
      })}
    >
      {label}
    </button>
  );
}
