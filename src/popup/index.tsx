/**
 * Browser-action popup. Quick status + per-tab overrides.
 *
 * Two jobs:
 *   1. Show "is everything connected right now?" at a glance.
 *   2. Let the user override save targets for *this tab only* without
 *      changing the global default.
 *
 * Anything more elaborate (Anki field mapping, AI keys, dictionary
 * manager) lives in the options page.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  Cloud,
  Monitor,
  Layers,
  ListVideo,
  Settings as SettingsIcon,
  LogIn,
  Sparkles,
  Compass,
  ChartColumn,
} from 'lucide-react';

import { sendMsgAsync } from '../lib/chromeApi';
import type { Settings, TabOverride } from '../lib/settings';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { cn } from '../lib/utils';

import '../index.css';
import { initPageTheme } from '../lib/theme';

initPageTheme();

function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ankiOk, setAnkiOk] = useState<boolean | null>(null);
  const [desktop, setDesktop] = useState<{ online: boolean; hasToken: boolean } | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [override, setOverride] = useState<TabOverride | null>(null);
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const id = tab?.id ?? null;
    setTabId(id);

    const [s, anki, desk] = await Promise.all([
      sendMsgAsync<Settings>({ action: 'getSettings' }),
      sendMsgAsync<{ mode: string | null }>({ action: 'ankiDetect' }),
      sendMsgAsync<{ online: boolean; hasToken: boolean }>({ action: 'desktopStatus' }),
    ]);
    if (s.success) setSettings((s as { data?: Settings }).data || null);
    setAnkiOk(anki.success ? (anki as { mode: string | null }).mode !== null : false);
    if (desk.success) setDesktop(desk as { online: boolean; hasToken: boolean });

    if (id !== null) {
      const ov = await sendMsgAsync<{ override: TabOverride | null }>({
        action: 'getTabOverride',
        tabId: id,
      });
      if (ov.success) setOverride((ov as { override: TabOverride | null }).override);
    }
  }

  async function saveSettings(patch: Partial<Settings>) {
    await sendMsgAsync({ action: 'patchSettings', patch });
    void refresh();
  }

  async function patchOverride(p: Partial<TabOverride>) {
    if (tabId === null) return;
    await sendMsgAsync({ action: 'setTabOverride', tabId, patch: p });
    void refresh();
  }

  async function clearOverride() {
    if (tabId === null) return;
    await sendMsgAsync({ action: 'setTabOverride', tabId, patch: null });
    void refresh();
  }

  async function pair() {
    setPairing(true);
    await sendMsgAsync({ action: 'desktopPair' });
    setPairing(false);
    void refresh();
  }

  async function signInCloud() {
    await sendMsgAsync({ action: 'openCloudAuth' });
    window.close();
  }

  if (!settings) {
    return (
      <div className="flex h-32 items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const desktopPaired = !!(desktop?.online && desktop.hasToken);
  const desktopAvailable = !!desktop?.online;
  const hasOverride =
    !!override &&
    (override.anki !== null || override.tokoriLocal !== null || override.tokoriCloud !== null);

  return (
    // Compact enough to fit Chrome's 600px popup cap without scrolling —
    // if a future row pushes past it anyway, the thin themed scrollbar
    // from index.css takes over instead of the chunky UA default.
    <div className="flex flex-col gap-2 bg-background p-3 pb-2.5 text-foreground">
      {/* Brand row */}
      <div className="flex items-center gap-2">
        <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-5" />
        <span className="text-sm font-semibold">Tokori Companion</span>
        <span className="flex-1" />
        <Select
          value={settings.mode}
          onValueChange={(v) => saveSettings({ mode: v as 'local' | 'cloud' })}
        >
          <SelectTrigger size="sm" className="h-7 w-auto rounded-full px-2.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="cloud">Cloud</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Connection rows */}
      <SectionLabel icon={Compass}>Connections</SectionLabel>
      <div className="flex flex-col gap-1.5">
        <ConnRow
          icon={<Cloud className="size-4 text-primary" />}
          label="Tokori cloud"
          status={settings.cloud.email ? 'ok' : 'idle'}
          detail={settings.cloud.email || 'Not signed in'}
          action={
            !settings.cloud.email && (
              <Button onClick={signInCloud} size="xs" variant="secondary">
                <LogIn data-icon="inline-start" /> Sign in
              </Button>
            )
          }
        />
        <ConnRow
          icon={<Monitor className="size-4 text-primary" />}
          label="Desktop app"
          status={desktopPaired ? 'ok' : desktopAvailable ? 'warn' : 'idle'}
          detail={
            desktopPaired ? 'Paired' : desktopAvailable ? 'Detected — not paired' : 'Not running'
          }
          action={
            desktopAvailable &&
            !desktopPaired && (
              <Button onClick={pair} disabled={pairing} size="xs">
                {pairing ? 'Awaiting…' : 'Pair'}
              </Button>
            )
          }
        />
        <ConnRow
          icon={<Layers className="size-4 text-primary" />}
          label="Anki"
          status={ankiOk ? 'ok' : 'idle'}
          detail={ankiOk ? 'AnkiConnect ready' : 'Offline'}
        />
      </div>

      <Separator />

      {/* Global save targets */}
      <SectionLabel>Save targets · global</SectionLabel>
      <div className="flex flex-col gap-1.5">
        <ToggleLine
          label="Anki"
          checked={settings.save.anki}
          onCheckedChange={(v) => saveSettings({ save: { ...settings.save, anki: v } })}
        />
        <ToggleLine
          label="Tokori desktop"
          checked={settings.save.tokoriLocal}
          onCheckedChange={(v) => saveSettings({ save: { ...settings.save, tokoriLocal: v } })}
        />
        <ToggleLine
          label="Tokori cloud"
          checked={settings.save.tokoriCloud}
          onCheckedChange={(v) => saveSettings({ save: { ...settings.save, tokoriCloud: v } })}
        />
      </div>

      <Separator />

      {/* Per-tab override */}
      <div className="flex items-center justify-between">
        <SectionLabel className="mb-0">This tab only</SectionLabel>
        {hasOverride && (
          <button
            onClick={clearOverride}
            className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      <p className="-mt-1 text-[11px] leading-snug text-muted-foreground">
        Overrides the global default for the current tab. Cleared when you close it.
      </p>
      <div className="flex flex-col gap-1">
        <TriToggle
          label="Anki"
          value={override?.anki ?? null}
          onChange={(v) => patchOverride({ anki: v })}
        />
        <TriToggle
          label="Tokori desktop"
          value={override?.tokoriLocal ?? null}
          onChange={(v) => patchOverride({ tokoriLocal: v })}
        />
        <TriToggle
          label="Tokori cloud"
          value={override?.tokoriCloud ?? null}
          onChange={(v) => patchOverride({ tokoriCloud: v })}
        />
      </div>

      <Separator />

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2">
        <Button onClick={() => chrome.runtime.openOptionsPage()} size="sm" className="flex-1">
          <SettingsIcon data-icon="inline-start" /> Settings
        </Button>
        <Button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('library.html') })}
          variant="ghost"
          size="sm"
          title="Your watch library — queued videos with progress"
        >
          <ListVideo data-icon="inline-start" /> Library
        </Button>
        <Button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') })}
          variant="ghost"
          size="sm"
          title="Immersion time statistics"
        >
          <ChartColumn data-icon="inline-start" /> Stats
        </Button>
        <Button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })}
          variant="ghost"
          size="sm"
        >
          <Sparkles data-icon="inline-start" /> Welcome
        </Button>
      </div>
    </div>
  );
}

function SectionLabel({
  children,
  icon: Icon,
  className,
}: {
  children: React.ReactNode;
  icon?: typeof Sparkles;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
    >
      {Icon && <Icon className="size-3" />}
      <span>{children}</span>
    </div>
  );
}

function ConnRow({
  icon,
  label,
  status,
  detail,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  status: 'ok' | 'warn' | 'idle';
  detail: string;
  action?: React.ReactNode;
}) {
  const dot =
    status === 'ok' ? 'bg-success' : status === 'warn' ? 'bg-primary' : 'bg-muted-foreground/40';
  return (
    <div className="flex items-center gap-2.5 rounded-md border bg-card/40 px-2.5 py-1">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary/10">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{label}</span>
          <span className={cn('size-1.5 rounded-full', dot)} />
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function ToggleLine({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <Label className="flex cursor-pointer items-center justify-between px-1 py-0.5 text-xs font-normal">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </Label>
  );
}

function TriToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const key = value === null ? 'default' : value ? 'on' : 'off';
  return (
    <div className="flex items-center justify-between px-1 text-xs">
      <span>{label}</span>
      <ToggleGroup
        type="single"
        value={key}
        onValueChange={(v) => {
          if (!v) return;
          if (v === 'default') onChange(null);
          else onChange(v === 'on');
        }}
        size="sm"
      >
        <ToggleGroupItem value="default" className="px-2 text-[10px]">
          default
        </ToggleGroupItem>
        <ToggleGroupItem value="on" className="px-2 text-[10px]">
          on
        </ToggleGroupItem>
        <ToggleGroupItem value="off" className="px-2 text-[10px]">
          off
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
