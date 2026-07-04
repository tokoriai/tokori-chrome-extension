/**
 * Theme tokens + shadow-DOM CSS for the content overlay.
 *
 * The content script lives inside a Shadow DOM (see content/index.tsx),
 * which means Tailwind classes from the host page won't bleed in and
 * our styles won't bleed out. We can't use Tailwind here either —
 * crxjs doesn't run Tailwind on Shadow-DOM content, and shipping the
 * Tailwind runtime into every page would balloon the bundle. Instead
 * we use a single CSS string + inline styles via the `s()` helper.
 *
 * TOKEN values are `var(--tk-*)` references, not literals: the shadow
 * root defines a light palette by default and swaps to the dark one on
 * `prefers-color-scheme: dark`, so every inline style that uses TOKENS
 * is automatically theme-aware. Surfaces that must stay dark no matter
 * the OS theme (the on-video caption overlay, the caption sidebar next
 * to the player) opt out with the `tk-force-dark` class — or, for DOM
 * portaled *outside* the shadow root, by injecting `TK_DARK_VARS` on
 * the host element (see CaptionSidebar's dock host).
 *
 * The palette is the Tokori desktop app's (src/index.css there):
 * white/slate light theme, deep-slate dark theme, indigo-violet brand.
 */

/** Dark palette — mirrors the desktop's `.dark` block. `--tk-primary`
 *  is the desktop's shadcn PRIMARY (neutral near-white in dark, near-
 *  black in light) — main-action buttons use it, NOT the indigo accent,
 *  matching the desktop's button look exactly. */
export const TK_DARK_VARS = `
  --tk-bg: oklch(0.13 0.006 250);
  --tk-surface: oklch(0.165 0.007 250);
  --tk-surface-hi: oklch(0.24 0.01 250);
  --tk-border: oklch(1 0 0 / 0.1);
  --tk-text: oklch(0.97 0.005 250);
  --tk-text-muted: oklch(0.71 0.012 250);
  --tk-primary: oklch(0.97 0.005 250);
  --tk-primary-fg: oklch(0.21 0.01 250);
  --tk-accent: oklch(0.7 0.18 280);
  --tk-accent-hi: oklch(0.78 0.16 280);
  --tk-ok: oklch(0.74 0.13 152);
  --tk-warn: oklch(0.8 0.15 80);
  --tk-err: oklch(0.7 0.2 22);
`;

/** Light palette — mirrors the desktop's `:root` block. */
const TK_LIGHT_VARS = `
  --tk-bg: oklch(0.985 0.003 250);
  --tk-surface: oklch(1 0 0);
  --tk-surface-hi: oklch(0.965 0.006 250);
  --tk-border: oklch(0.93 0.006 250);
  --tk-text: oklch(0.16 0.005 250);
  --tk-text-muted: oklch(0.51 0.01 250);
  --tk-primary: oklch(0.21 0.01 250);
  --tk-primary-fg: oklch(0.985 0.003 250);
  --tk-accent: oklch(0.55 0.2 280);
  --tk-accent-hi: oklch(0.62 0.18 280);
  --tk-ok: oklch(0.55 0.13 152);
  --tk-warn: oklch(0.66 0.15 70);
  --tk-err: oklch(0.585 0.225 27);
`;

export const TOKENS = {
  bg: 'var(--tk-bg)',
  surface: 'var(--tk-surface)',
  surfaceHi: 'var(--tk-surface-hi)',
  border: 'var(--tk-border)',
  text: 'var(--tk-text)',
  textMuted: 'var(--tk-text-muted)',
  primary: 'var(--tk-primary)',
  primaryFg: 'var(--tk-primary-fg)',
  accent: 'var(--tk-accent)',
  accentHi: 'var(--tk-accent-hi)',
  ok: 'var(--tk-ok)',
  warn: 'var(--tk-warn)',
  err: 'var(--tk-err)',
  radius: '12px', // matches the desktop's --radius: 0.75rem
} as const;

/** Same sans stack as the desktop's `--font-sans`. Inter is bundled on
 *  the extension's own pages; on arbitrary host pages the fallbacks
 *  carry it. */
export const TK_FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Inline-style helper. Typed identity returning React.CSSProperties
 *  so callers get autocomplete + narrowed union checking on enum
 *  properties like `flexDirection`, `pointerEvents`, `overflowY`. */
import type { CSSProperties } from 'react';
export function s(o: CSSProperties): CSSProperties {
  return o;
}

/** Follow the OS theme on extension pages (options / popup / welcome)
 *  by toggling html.dark — the same class convention the desktop app
 *  uses, so the shared shadcn variables light/dark correctly. */
export function initPageTheme(): void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
  apply();
  mq.addEventListener('change', apply);
}

/** Single stylesheet injected into the shadow root. Theme variables +
 *  animations — the rest of the component styling is inline so we
 *  don't have to manage shadow-DOM-aware class names. */
export const SHADOW_CSS = `
:host { all: initial; ${TK_LIGHT_VARS} }
@media (prefers-color-scheme: dark) { :host { ${TK_DARK_VARS} } }
/* Surfaces that sit on top of / beside the video stay dark regardless
 * of the OS theme — captions on a video frame need it. */
.tk-force-dark { ${TK_DARK_VARS} }

* {
  box-sizing: border-box;
  font-family: ${TK_FONT_SANS};
  font-feature-settings: "cv11", "ss01", "ss03";
  /* Thin, theme-aware scrollbars on every scrollable surface we render
   * (dict popup, analyzer body, collections panel) — same design as the
   * caption sidebar's. */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--tk-text-muted) 40%, transparent) transparent;
}
button { font: inherit; cursor: pointer; }

@keyframes tk-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes tk-pop-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
@keyframes tk-spin { to { transform: rotate(360deg); } }

.tk-popup { animation: tk-fade-in 120ms ease-out both; }
.tk-modal { animation: tk-pop-in 140ms ease-out both; }
.tk-spinner {
  width: 14px; height: 14px;
  border: 2px solid ${TOKENS.border};
  border-top-color: ${TOKENS.accent};
  border-radius: 50%;
  animation: tk-spin 700ms linear infinite;
}

.tk-link { color: ${TOKENS.accent}; text-decoration: none; cursor: pointer; }
.tk-link:hover { color: ${TOKENS.accentHi}; text-decoration: underline; }

/* Buttons — the desktop app's shadcn button variants, translated to the
 * shadow DOM (inline styles can't express :hover, so these live here).
 * Outline = border + transparent bg, hover fills with the raised
 * surface; primary = indigo brand; ghost = borderless muted. */
.tk-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.tk-btn:disabled { opacity: 0.55; cursor: default; }
.tk-btn-outline {
  background: transparent;
  color: ${TOKENS.text};
  border: 1px solid ${TOKENS.border};
}
.tk-btn-outline:hover:not(:disabled) { background: ${TOKENS.surfaceHi}; }
.tk-btn-primary {
  background: ${TOKENS.primary};
  color: ${TOKENS.primaryFg};
  border: none;
}
.tk-btn-primary:hover:not(:disabled) {
  background: color-mix(in oklch, ${TOKENS.primary} 88%, transparent);
}
.tk-btn-ghost {
  background: transparent;
  color: ${TOKENS.textMuted};
  border: none;
}
.tk-btn-ghost:hover:not(:disabled) { background: ${TOKENS.surfaceHi}; color: ${TOKENS.text}; }
/* Round icon button (chevrons, speak, close) — desktop's size-6 circle. */
.tk-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid ${TOKENS.border};
  background: transparent;
  color: ${TOKENS.textMuted};
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
  transition: background 120ms ease, color 120ms ease;
}
.tk-iconbtn:hover:not(:disabled) { background: ${TOKENS.surfaceHi}; color: ${TOKENS.text}; }
.tk-iconbtn:disabled { opacity: 0.35; cursor: default; }

/* Pinyin / phonetic reading — same sans stack, slightly tracked, like
 * the desktop's .ruby-pinyin-rt. */
.tk-pinyin {
  font-family: ${TK_FONT_SANS};
  font-style: normal;
  font-weight: 500;
  letter-spacing: 0.03em;
}

/* Ruby annotation text (pinyin / furigana above words). Mirrors the
 * desktop's .ruby-pinyin-rt: small, medium weight, decoration-free
 * (defensive — browsers already skip rt when painting underlines).
 * Colour inherits from the word unless a tone attribute overrides. */
.tk-rt {
  font-family: ${TK_FONT_SANS};
  font-size: 0.5em;
  font-weight: 500;
  letter-spacing: 0.02em;
  opacity: 0.85;
  user-select: none;
  text-decoration: none;
  ruby-align: center;
}

/* Mandarin tone colours — Pleco's classic palette, same values as the
 * desktop's --tone-* defaults (index.css there). Applied per-syllable
 * on <rt data-tone="N"> by RubyWord. */
.tk-rt[data-tone="1"] { color: #e53935; opacity: 1; }
.tk-rt[data-tone="2"] { color: #fb8c00; opacity: 1; }
.tk-rt[data-tone="3"] { color: #43a047; opacity: 1; }
.tk-rt[data-tone="4"] { color: #1e88e5; opacity: 1; }
.tk-rt[data-tone="5"] { color: #9e9e9e; opacity: 1; }
`;
