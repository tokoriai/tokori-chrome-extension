/**
 * Content-script entry. Mounts a Shadow-DOM React tree so our styles
 * don't bleed into the host page and vice versa. Each surface (hover
 * popup, sentence analyzer modal, YouTube enhancer) is its own root component listening for `window`-level
 * custom events fired from a global text-selection listener.
 */

import { createRoot } from 'react-dom/client';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { SHADOW_CSS, TOKENS, s } from '../lib/theme';
import { HoverPopup } from './HoverPopup';
import { SentenceAnalyzerModal } from './SentenceAnalyzerModal';
import { NetflixEnhancer, DisneyPlusEnhancer } from './StreamingDualSubs';
import { BilibiliTvOcrSubs } from './OcrDualSubs';
import { YouTubeEnhancer } from './YouTubeEnhancer';
import { MiningModal, type MinerOpenDetail } from './MiningModal';
import type { LanguageCode } from '../lib/languages';

// Skip injection on Tokori's own surfaces — the desktop app and the
// hosted web app already have their own click-to-define / vocab
// surfaces, no need for a duplicate overlay.
const host = window.location.hostname;
if (
  host === 'app.tokori.ai' ||
  host === 'tokori.ai' ||
  host === 'www.tokori.ai' ||
  (host === 'localhost' && window.location.port === '5173')
) {
  // Drop a marker div so the web app can detect the extension is
  // installed (used by future onboarding gates).
  const marker = document.createElement('div');
  marker.id = 'tokori-extension-installed';
  marker.style.display = 'none';
  const attach = () => document.body.appendChild(marker);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
} else {
  mount();
}

// Known-words push channel: the background rewrites its storage.local
// snapshot whenever the map actually changes (refresh, grade, save).
// Relay that as the window event every consumer already listens for —
// no per-tab messaging, and open YouTube tabs recolour immediately.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.knownWordsSnapshot) {
      window.dispatchEvent(new CustomEvent('tokori-known-words-changed'));
    }
  });
} catch {
  /* extension context invalidated — consumers fall back to polling */
}

function mount() {
  const root = document.createElement('div');
  root.id = 'tokori-companion-root';
  root.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
  const shadow = root.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHADOW_CSS;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.documentElement.appendChild(root);
  createRoot(mountPoint).render(<TokoriApp />);
}

/** How long a crashed surface stays down before remounting, and how
 *  many remounts a page gets — a transient crash heals, a genuine
 *  crash-loop parks after the cap instead of spinning. */
const SURFACE_RETRY_MS = 4000;
const SURFACE_MAX_RETRIES = 3;

/** One crashing surface must never take the others down: the site
 *  enhancers ride host-page DOM that shifts under A/B tests (YouTube
 *  especially), and an uncaught render/effect error would otherwise
 *  unmount the ENTIRE content tree — popup, miner, everything — which
 *  reads as "the extension stopped loading". Failed surfaces log,
 *  render nothing, and REMOUNT after a short pause (capped): a one-off
 *  DOM race then costs a few seconds of absence — the player-bar OCR
 *  button included — instead of the whole surface staying gone until
 *  the user thinks to reload the tab. */
class SurfaceBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  private retries = 0;
  private timer: number | null = null;
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    try {
      console.warn(`[tokori] ${this.props.name} surface crashed:`, error);
    } catch {
      /* console gone — nothing to do */
    }
    if (this.retries < SURFACE_MAX_RETRIES) {
      this.retries += 1;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.setState({ failed: false });
      }, SURFACE_RETRY_MS);
    }
  }
  componentWillUnmount() {
    if (this.timer !== null) window.clearTimeout(this.timer);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Detects the orphaned-tab state: reloading/updating the extension
 *  invalidates the context of content scripts in ALREADY-OPEN tabs —
 *  every chrome.* call starts throwing while the page-side JS keeps
 *  running, so the surfaces silently degrade into "the extension
 *  stopped loading". Surface it instead: a small toast naming the fix
 *  (reload the tab). Polling chrome.runtime.id is the standard probe —
 *  it reads undefined (or throws) once the context is gone. */
function OrphanNotice() {
  const [orphaned, setOrphaned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      let dead: boolean;
      try {
        dead = !chrome.runtime?.id;
      } catch {
        dead = true;
      }
      if (dead) {
        setOrphaned(true);
        window.clearInterval(timer);
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  if (!orphaned || dismissed) return null;
  return (
    <div
      className="tk-force-dark"
      style={s({
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'rgba(15,17,21,0.97)',
        color: TOKENS.text,
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: '10px',
        padding: '10px 12px',
        fontSize: '13px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        pointerEvents: 'auto',
        fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif',
      })}
    >
      <span>Tokori was updated — reload this tab to reactivate it.</span>
      <button
        onClick={() => window.location.reload()}
        style={s({
          background: TOKENS.accent,
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          padding: '5px 12px',
          fontSize: '12px',
          fontWeight: '600',
          cursor: 'pointer',
        })}
      >
        Reload
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={s({
          background: 'transparent',
          border: 'none',
          color: TOKENS.textMuted,
          fontSize: '15px',
          lineHeight: '1',
          cursor: 'pointer',
          padding: '0 2px',
        })}
      >
        ×
      </button>
    </div>
  );
}

function TokoriApp() {
  const [analyzerSentence, setAnalyzerSentence] = useState<{
    text: string;
    lang: LanguageCode | null;
    /** Video surfaces pass the cue list + index so the analyzer can
     *  page ‹ › through subtitle lines and seek the player along. */
    cues?: Array<{ text: string; start: number }>;
    index?: number;
  } | null>(null);
  const [minerDetail, setMinerDetail] = useState<MinerOpenDetail | null>(null);

  useEffect(() => {
    const onOpenAnalyzer = (e: Event) => {
      const ce = e as CustomEvent<{
        text: string;
        lang: LanguageCode | null;
        cues?: Array<{ text: string; start: number }>;
        index?: number;
      }>;
      if (ce.detail?.text) setAnalyzerSentence(ce.detail);
    };
    const onOpenMiner = (e: Event) => {
      const ce = e as CustomEvent<MinerOpenDetail | undefined>;
      // No detail = toolbar-trigger from a site enhancer (YT). The
      // modal pulls everything from getMiningSource() in that case.
      setMinerDetail(ce.detail || {});
    };
    window.addEventListener('tokori-open-analyzer', onOpenAnalyzer as EventListener);
    window.addEventListener('tokori-open-miner', onOpenMiner as EventListener);
    return () => {
      window.removeEventListener('tokori-open-analyzer', onOpenAnalyzer as EventListener);
      window.removeEventListener('tokori-open-miner', onOpenMiner as EventListener);
    };
  }, []);

  return (
    <>
      <SurfaceBoundary name="orphan-notice">
        <OrphanNotice />
      </SurfaceBoundary>
      <SurfaceBoundary name="hover-popup">
        <HoverPopup />
      </SurfaceBoundary>
      <SurfaceBoundary name="youtube">
        <YouTubeEnhancer />
      </SurfaceBoundary>
      <SurfaceBoundary name="netflix">
        <NetflixEnhancer />
      </SurfaceBoundary>
      <SurfaceBoundary name="disneyplus">
        <DisneyPlusEnhancer />
      </SurfaceBoundary>
      <SurfaceBoundary name="bilibili-tv">
        <BilibiliTvOcrSubs />
      </SurfaceBoundary>
      {analyzerSentence && (
        <SurfaceBoundary name="analyzer">
          <SentenceAnalyzerModal
            sentence={analyzerSentence.text}
            lang={analyzerSentence.lang}
            cues={analyzerSentence.cues}
            initialIndex={analyzerSentence.index}
            onClose={() => setAnalyzerSentence(null)}
          />
        </SurfaceBoundary>
      )}
      {minerDetail && (
        <SurfaceBoundary name="miner">
          <MiningModal detail={minerDetail} onClose={() => setMinerDetail(null)} />
        </SurfaceBoundary>
      )}
    </>
  );
}
