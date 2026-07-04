/**
 * Content-script entry. Mounts a Shadow-DOM React tree so our styles
 * don't bleed into the host page and vice versa. Each surface (hover
 * popup, sentence analyzer modal, YouTube enhancer) is its own root component listening for `window`-level
 * custom events fired from a global text-selection listener.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { SHADOW_CSS } from '../lib/theme';
import { HoverPopup } from './HoverPopup';
import { SentenceAnalyzerModal } from './SentenceAnalyzerModal';
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
      <HoverPopup />
      <YouTubeEnhancer />
      {analyzerSentence && (
        <SentenceAnalyzerModal
          sentence={analyzerSentence.text}
          lang={analyzerSentence.lang}
          cues={analyzerSentence.cues}
          initialIndex={analyzerSentence.index}
          onClose={() => setAnalyzerSentence(null)}
        />
      )}
      {minerDetail && <MiningModal detail={minerDetail} onClose={() => setMinerDetail(null)} />}
    </>
  );
}
