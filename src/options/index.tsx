/**
 * Options page. Sidebar nav on the left, single content panel on the
 * right — mirrors the Tokori desktop app's settings layout.
 *
 * Sections:
 *   • General     — target language, trigger mode, save defaults
 *   • Account     — Tokori cloud sign-in (URL flow + paste-token fallback)
 *   • Desktop     — local IPC pairing, auto-detect, AI/dict preferences
 *   • Anki        — deck, model, field map
 *   • Dictionaries — install / import / delete
 *   • AI keys     — BYO OpenAI / Anthropic / Gemini
 *   • About       — version, reset
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  Cloud,
  Monitor,
  Layers,
  BookOpen,
  Info,
  Pickaxe,
  Sparkles,
} from 'lucide-react';

import { sendMsgAsync } from '../lib/chromeApi';
import type { Settings } from '../lib/settings';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { DictMeta } from '../lib/dictionaries/idb';
import { cn } from '../lib/utils';

import { GeneralPanel } from './panels/GeneralPanel';
import { CloudPanel } from './panels/CloudPanel';
import { DesktopPanel } from './panels/DesktopPanel';
import { AnkiPanel } from './panels/AnkiPanel';
import { MiningPanel } from './panels/MiningPanel';
import { DictPanel } from './panels/DictPanel';
import { AiPanel } from './panels/AiPanel';
import { AboutPanel } from './panels/AboutPanel';

import '../index.css';
import { initPageTheme } from '../lib/theme';

initPageTheme();

type SectionId = 'general' | 'account' | 'desktop' | 'anki' | 'mining' | 'dicts' | 'ai' | 'about';

interface SectionDef {
  id: SectionId;
  label: string;
  icon: typeof SettingsIcon;
  description: string;
}

const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: SettingsIcon,
    description: 'Target language, trigger mode, save defaults',
  },
  {
    id: 'account',
    label: 'Tokori account',
    icon: Cloud,
    description: 'Sign in to sync with Tokori cloud',
  },
  {
    id: 'desktop',
    label: 'Tokori desktop',
    icon: Monitor,
    description: 'Pair with the local Tokori app',
  },
  { id: 'anki', label: 'Anki', icon: Layers, description: 'AnkiConnect deck, model, field map' },
  {
    id: 'mining',
    label: 'Sentence miner',
    icon: Pickaxe,
    description: 'Screenshot + clip capture for mined cards',
  },
  {
    id: 'dicts',
    label: 'Dictionaries',
    icon: BookOpen,
    description: 'Install or import dictionary data',
  },
  {
    id: 'ai',
    label: 'AI',
    icon: Sparkles,
    description: 'Bring your own OpenAI / Anthropic / Gemini key',
  },
  { id: 'about', label: 'About', icon: Info, description: 'Version and reset' },
];

function Options() {
  const [section, setSection] = useState<SectionId>(() => {
    const hash = window.location.hash.replace('#', '');
    return SECTIONS.find((s) => s.id === hash)?.id || 'general';
  });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [installedDicts, setInstalledDicts] = useState<DictMeta[]>([]);

  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    window.location.hash = section;
  }, [section]);

  async function refresh() {
    const s = await sendMsgAsync<Settings>({ action: 'getSettings' });
    if (s.success) setSettings((s as { data?: Settings }).data || DEFAULT_SETTINGS);
    const d = await sendMsgAsync<{ metas: DictMeta[] }>({ action: 'dictListInstalled' });
    if (d.success) setInstalledDicts((d as { metas: DictMeta[] }).metas || []);
  }

  async function patch(p: Partial<Settings>) {
    setSettings((prev) => ({ ...prev, ...p }));
    await sendMsgAsync({ action: 'patchSettings', patch: p });
  }

  const active = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="grid min-h-screen grid-cols-[260px_1fr] bg-background text-foreground">
      <Sidebar active={section} onPick={setSection} settings={settings} />
      <main className="min-w-0">
        <div className="border-b px-10 pt-10 pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">{active.label}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{active.description}</p>
        </div>
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-10 py-6 pb-20">
          {section === 'general' && <GeneralPanel settings={settings} patch={patch} />}
          {section === 'account' && <CloudPanel settings={settings} patch={patch} />}
          {section === 'desktop' && (
            <DesktopPanel settings={settings} patch={patch} onChange={refresh} />
          )}
          {section === 'anki' && <AnkiPanel settings={settings} patch={patch} />}
          {section === 'mining' && (
            <MiningPanel settings={settings} patch={patch} onRefresh={refresh} />
          )}
          {section === 'dicts' && (
            <DictPanel settings={settings} installed={installedDicts} onChange={refresh} />
          )}
          {section === 'ai' && <AiPanel settings={settings} patch={patch} />}
          {section === 'about' && <AboutPanel onChange={refresh} />}
        </div>
      </main>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────

function Sidebar({
  active,
  onPick,
  settings,
}: {
  active: SectionId;
  onPick: (id: SectionId) => void;
  settings: Settings;
}) {
  return (
    <aside className="sticky top-0 flex h-screen flex-col border-r bg-sidebar">
      <div className="flex items-center gap-2.5 border-b px-5 py-5">
        <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-7" />
        <div>
          <div className="text-sm font-semibold leading-tight">Tokori Companion</div>
          <div className="text-[11px] text-muted-foreground">Settings</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3">
        {SECTIONS.map((s) => {
          const isActive = s.id === active;
          const Icon = s.icon;
          const liveDot =
            (s.id === 'desktop' && settings.desktopOnline) ||
            (s.id === 'account' && settings.cloud.email);
          return (
            <button
              key={s.id}
              onClick={() => onPick(s.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1">{s.label}</span>
              {liveDot && <span className="size-1.5 rounded-full bg-success" />}
            </button>
          );
        })}
      </nav>
      <div className="border-t px-5 py-3 text-[11px] text-muted-foreground">
        v{chrome.runtime.getManifest().version} · local-first
      </div>
    </aside>
  );
}

createRoot(document.getElementById('root')!).render(<Options />);
