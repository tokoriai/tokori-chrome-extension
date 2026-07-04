/**
 * First-run onboarding. Three-step flow modelled after the
 * hanpanda extension: Pin → Sign in → Quick settings. Each step has a
 * brand header, a step indicator, content cards, and Back/Continue
 * footers. Polling refreshes the status (pin/auth) so the page reacts
 * to user actions taken in other tabs without a refresh.
 *
 * Persists `onboardingComplete: true` and closes the tab on finish so
 * a later re-install doesn't re-open it.
 */

import { createRoot } from 'react-dom/client';
import { useState, useEffect, useCallback } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Pin,
  Cloud,
  Monitor,
  Sparkles,
  BookOpen,
  Languages,
  Tv,
  Send,
  LogIn,
  AlertCircle,
} from 'lucide-react';

import { sendMsgAsync, storageSet } from '../lib/chromeApi';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { cn } from '../lib/utils';
import type { Settings } from '../lib/settings';
import { LANGUAGES, type LanguageCode } from '../lib/languages';

import '../index.css';
import { initPageTheme } from '../lib/theme';

initPageTheme();

type StepId = 'pin' | 'sign-in' | 'quick';
const STEPS: StepId[] = ['pin', 'sign-in', 'quick'];

function Welcome() {
  const [step, setStep] = useState<StepId>('pin');
  const [animating, setAnimating] = useState(false);

  const goTo = (next: StepId) => {
    setAnimating(true);
    window.setTimeout(() => {
      setStep(next);
      setAnimating(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 160);
  };

  async function finish() {
    await storageSet({ onboardingComplete: true });
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) chrome.tabs.remove(tab.id);
      else window.close();
    } catch {
      window.close();
    }
  }

  const idx = STEPS.indexOf(step);

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 py-12">
        <Brand />
        <StepIndicator current={idx} />

        <div
          className={cn(
            'flex w-full flex-col items-stretch gap-4 transition-opacity duration-200',
            animating ? 'opacity-0' : 'opacity-100',
          )}
        >
          {step === 'pin' && <PinStep onNext={() => goTo('sign-in')} />}
          {step === 'sign-in' && (
            <SignInStep onNext={() => goTo('quick')} onBack={() => goTo('pin')} />
          )}
          {step === 'quick' && (
            <QuickSettingsStep onBack={() => goTo('sign-in')} onFinish={finish} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Brand + step indicator ────────────────────────────────────────

function Brand() {
  return (
    <div className="mb-6 flex flex-col items-center text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/90 to-primary shadow-lg shadow-primary/20">
        <img src={chrome.runtime.getURL('src/icons/icon-128.png')} alt="" className="size-10" />
      </div>
      <Badge variant="secondary" className="mb-2 uppercase tracking-wider">
        Welcome to
      </Badge>
      <h1 className="text-3xl font-semibold tracking-tight">Tokori Companion</h1>
      <p className="mt-2 text-sm text-muted-foreground">Read. Click. Mine. Send to Tokori.</p>
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border bg-card/60 px-3 py-1 text-xs text-muted-foreground">
        <Check className="size-3 text-success" />
        Works standalone — no Tokori account or desktop app required
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  const labels = ['Pin', 'Sign in', 'Settings'];
  return (
    <div className="mb-8 flex items-center gap-2">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={cn(
              'flex size-7 items-center justify-center rounded-full text-xs font-semibold transition-all',
              i < current && 'bg-primary text-primary-foreground',
              i === current && 'bg-primary text-primary-foreground shadow-lg shadow-primary/30',
              i > current && 'bg-muted text-muted-foreground',
            )}
            aria-label={label}
          >
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </div>
          {i < labels.length - 1 && (
            <div className={cn('h-px w-10', i < current ? 'bg-primary' : 'bg-border')} />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Step 1 · Pin ─────────────────────────────────────────────────

function PinStep({ onNext }: { onNext: () => void }) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [canCheck, setCanCheck] = useState(true);

  const probe = useCallback(() => {
    try {
      if (chrome?.action?.getUserSettings) {
        chrome.action
          .getUserSettings()
          .then((s) => setPinned(!!s.isOnToolbar))
          .catch(() => setCanCheck(false));
      } else {
        setCanCheck(false);
      }
    } catch {
      setCanCheck(false);
    }
  }, []);

  useEffect(() => {
    probe();
    const id = window.setInterval(probe, 2000);
    return () => window.clearInterval(id);
  }, [probe]);

  return (
    <>
      {!pinned && canCheck && <PinPointer />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Pin className="size-4 text-primary" /> Pin Tokori to your toolbar
          </CardTitle>
          <CardDescription>
            Keep the popup one click away — for status, per-tab overrides, and quick toggles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pinned ? (
            <Alert>
              <Check className="size-4 text-success" />
              <AlertTitle>Pinned</AlertTitle>
              <AlertDescription>The popup is one click away on your toolbar.</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-3">
              {[
                {
                  n: 1,
                  body: (
                    <>
                      Click the{' '}
                      <strong className="inline-flex items-center gap-1 text-foreground">
                        <ChromePuzzle className="size-4" /> puzzle icon
                      </strong>{' '}
                      in your toolbar
                    </>
                  ),
                },
                {
                  n: 2,
                  body: (
                    <>
                      Find <strong className="text-foreground">Tokori Companion</strong> in the list
                    </>
                  ),
                },
                {
                  n: 3,
                  body: (
                    <>
                      Click the{' '}
                      <strong className="inline-flex items-center gap-1 text-foreground">
                        <Pin className="size-4" /> pin
                      </strong>{' '}
                      to keep it visible
                    </>
                  ),
                },
              ].map((s) => (
                <div
                  key={s.n}
                  className="flex items-center gap-3 rounded-md border bg-card/60 px-3 py-2"
                >
                  <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-xs font-semibold text-primary">
                    {s.n}
                  </div>
                  <span className="text-sm">{s.body}</span>
                </div>
              ))}
              {!canCheck && (
                <p className="text-xs text-muted-foreground italic">
                  Your browser doesn't expose pin status, so we can't auto-confirm — continue when
                  you're ready.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            Why pin?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2.5 text-sm">
            <FeatureLine
              icon={Sparkles}
              text="Toggle save targets per tab — Anki only here, desktop only there."
            />
            <FeatureLine
              icon={Languages}
              text="See which dictionary / AI source is active right now."
            />
            <FeatureLine
              icon={Send}
              text="Send selection to Tokori reader or library in one click."
            />
            <FeatureLine
              icon={BookOpen}
              text="Quick re-pair if the desktop app comes online mid-session."
            />
          </ul>
        </CardContent>
      </Card>

      <div className="mt-3 flex flex-col items-center gap-2">
        <Button onClick={onNext} disabled={!pinned && canCheck} size="lg" className="px-8">
          Continue
          <ArrowRight data-icon="inline-end" />
        </Button>
        {!pinned && canCheck && (
          <Button onClick={onNext} variant="ghost" size="sm">
            Skip for now
          </Button>
        )}
      </div>
    </>
  );
}

function PinPointer() {
  // Chrome's puzzle icon sits in the top-right of the browser toolbar,
  // directly above the rendered page. The pointer anchors at top:0,
  // close to the right edge (where extensions live), and its arrow
  // points straight up so the eye is led off the page into the toolbar.
  return (
    <div
      className="pointer-events-none fixed top-0 right-12 z-[9999] flex flex-col items-center gap-1.5 pt-1 animate-in fade-in duration-500"
      aria-hidden
    >
      <svg
        width="44"
        height="78"
        viewBox="0 0 44 78"
        fill="none"
        className="animate-bounce text-primary"
        style={{ filter: 'drop-shadow(0 4px 12px hsl(var(--primary) / 0.5))' }}
      >
        {/* Mostly vertical curve from bottom-center to top, hinting up-and-right */}
        <path
          d="M 22 74 C 22 52, 30 32, 24 10"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        />
        {/* Arrowhead at top, apex at (24, 2) pointing straight up */}
        <polygon points="24,2 33,15 15,13" fill="currentColor" />
      </svg>
      <Badge className="animate-pulse gap-1.5 px-3 py-1 text-xs font-semibold shadow-lg shadow-primary/30">
        <ChromePuzzle className="size-3.5" />
        Click the puzzle icon
      </Badge>
    </div>
  );
}

// Chrome's extensions ("puzzle") toolbar icon — a single jigsaw piece
// in the same flat outlined style Material/Chrome use. lucide's
// `Puzzle` glyph is a four-piece grid that doesn't match what Chrome
// actually shows, so we render it inline.
function ChromePuzzle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M19.5 10c.83 0 1.5-.67 1.5-1.5S20.33 7 19.5 7H17V4.5C17 3.67 16.33 3 15.5 3S14 3.67 14 4.5V7h-3V4.5C11 3.67 10.33 3 9.5 3S8 3.67 8 4.5V7H4.5C3.67 7 3 7.67 3 8.5V13h2.5c1.93 0 3.5 1.57 3.5 3.5S7.43 20 5.5 20H3v.5C3 21.33 3.67 22 4.5 22H9v-2.5c0-1.93 1.57-3.5 3.5-3.5s3.5 1.57 3.5 3.5V22h4.5c.83 0 1.5-.67 1.5-1.5V17h-2.5c-1.93 0-3.5-1.57-3.5-3.5S19.57 10 21.5 10h-2z" />
    </svg>
  );
}

function FeatureLine({ icon: Icon, text }: { icon: typeof Sparkles; text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <span className="text-foreground/80">{text}</span>
    </li>
  );
}

// ── Step 2 · Sign in / connect ────────────────────────────────────

function SignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [desktopOnline, setDesktopOnline] = useState(false);
  const [desktopPaired, setDesktopPaired] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [openingAuth, setOpeningAuth] = useState(false);

  const refresh = useCallback(async () => {
    const s = await sendMsgAsync<Settings>({ action: 'getSettings' });
    if (s.success) setEmail((s as { data?: Settings }).data?.cloud?.email ?? null);
    const d = await sendMsgAsync<{ online: boolean; hasToken: boolean }>({
      action: 'desktopStatus',
    });
    if (d.success) {
      const r = d as { online: boolean; hasToken: boolean };
      setDesktopOnline(r.online);
      setDesktopPaired(r.online && r.hasToken);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function pair() {
    setPairing(true);
    await sendMsgAsync({ action: 'desktopPair' });
    setPairing(false);
    void refresh();
  }

  async function signInCloud() {
    setOpeningAuth(true);
    await sendMsgAsync({ action: 'openCloudAuth' });
    setOpeningAuth(false);
  }

  const anyConnected = !!email || desktopPaired;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            Connect Tokori{' '}
            <span className="text-xs font-normal text-muted-foreground">(optional)</span>
          </CardTitle>
          <CardDescription>
            Both are optional — the extension works without either. Connect to sync vocab, share
            dictionaries, and route AI through your Tokori account or desktop app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ConnectRow
            icon={<Monitor className="size-5 text-primary" />}
            title="Tokori desktop app"
            description={
              desktopPaired
                ? 'Paired — vocab, dicts, and AI flow through the app.'
                : desktopOnline
                  ? 'Detected — pair to share dictionaries and AI from the app.'
                  : 'Open the desktop app, then click Pair.'
            }
            badge={desktopPaired ? 'ok' : desktopOnline ? 'warn' : 'idle'}
            action={
              desktopOnline && !desktopPaired ? (
                <Button onClick={pair} disabled={pairing} size="sm">
                  {pairing ? 'Awaiting approval…' : 'Pair'}
                </Button>
              ) : !desktopOnline ? (
                <Button onClick={refresh} variant="outline" size="sm">
                  Re-check
                </Button>
              ) : null
            }
          />
          <ConnectRow
            icon={<Cloud className="size-5 text-primary" />}
            title="Tokori cloud account"
            description={
              email
                ? `Signed in as ${email}`
                : 'Sync vocab + library across devices. Required for Send-to-Tokori.'
            }
            badge={email ? 'ok' : 'idle'}
            action={
              !email && (
                <Button onClick={signInCloud} disabled={openingAuth} size="sm">
                  <LogIn data-icon="inline-start" />
                  {openingAuth ? 'Opening…' : 'Sign in'}
                </Button>
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            What you get
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2.5 text-sm">
            <FeatureLine
              icon={BookOpen}
              text="Hover any word for instant dictionary lookup — offline-first."
            />
            <FeatureLine icon={Tv} text="Click YouTube subtitles to mine words and sentences." />
            <FeatureLine icon={Send} text="One-click send articles to your Tokori reader queue." />
            <FeatureLine
              icon={Sparkles}
              text="AI sentence explanations via the desktop app or your own keys."
            />
          </ul>
        </CardContent>
      </Card>

      <div className="mt-3 flex items-center justify-between">
        <Button onClick={onBack} variant="ghost" size="sm">
          <ArrowLeft data-icon="inline-start" /> Back
        </Button>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={onNext} size="lg">
            Continue
            <ArrowRight data-icon="inline-end" />
          </Button>
          {!anyConnected && (
            <button
              onClick={onNext}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Skip for now
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function ConnectRow({
  icon,
  title,
  description,
  badge,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge: 'ok' | 'warn' | 'idle';
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card/60 px-3 py-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {badge === 'ok' && (
            <Badge className="bg-success/15 text-success ring-1 ring-success/30">Connected</Badge>
          )}
          {badge === 'warn' && <Badge variant="secondary">Available</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ── Step 3 · Quick settings ───────────────────────────────────────

type CloudWs = { id: number; name: string; targetLang: LanguageCode };
type LocalWs = { id: number; name: string; target_lang: LanguageCode };

function QuickSettingsStep({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cloudWorkspaces, setCloudWorkspaces] = useState<CloudWs[]>([]);
  const [localWorkspaces, setLocalWorkspaces] = useState<LocalWs[]>([]);

  const refresh = useCallback(async () => {
    const s = await sendMsgAsync<Settings>({ action: 'getSettings' });
    if (s.success) setSettings((s as { data?: Settings }).data ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cloudToken = settings?.cloud.token ?? null;
  const localToken = settings?.localApi.token ?? null;
  const desktopOnline = settings?.desktopOnline ?? false;

  useEffect(() => {
    if (!cloudToken) {
      setCloudWorkspaces([]);
      return;
    }
    void sendMsgAsync<{ workspaces: CloudWs[] }>({ action: 'cloudListWorkspaces' }).then((res) => {
      if (res.success) setCloudWorkspaces((res as { workspaces: CloudWs[] }).workspaces || []);
    });
  }, [cloudToken]);

  useEffect(() => {
    if (!localToken || !desktopOnline) {
      setLocalWorkspaces([]);
      return;
    }
    void sendMsgAsync<{ workspaces: LocalWs[] }>({ action: 'localListWorkspaces' }).then((res) => {
      if (res.success) setLocalWorkspaces((res as { workspaces: LocalWs[] }).workspaces || []);
    });
  }, [localToken, desktopOnline]);

  async function patch(p: Partial<Settings>) {
    if (!settings) return;
    setSettings({ ...settings, ...p });
    await sendMsgAsync({ action: 'patchSettings', patch: p });
  }

  function pickCloudWorkspace(id: number) {
    const ws = cloudWorkspaces.find((w) => w.id === id);
    if (!ws) return;
    void patch({ cloudWorkspaceId: id, defaultTargetLang: ws.targetLang });
  }

  function pickLocalWorkspace(id: number) {
    const ws = localWorkspaces.find((w) => w.id === id);
    if (!ws) return;
    void patch({ localWorkspaceId: id, defaultTargetLang: ws.target_lang });
  }

  if (!settings) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  type SaveTargetKey = 'auto' | 'anki' | 'desktop' | 'cloud';
  const currentTarget: SaveTargetKey = (() => {
    const { anki, tokoriLocal, tokoriCloud } = settings.save;
    if (anki && (tokoriLocal || tokoriCloud)) return 'auto';
    if (anki) return 'anki';
    if (tokoriLocal) return 'desktop';
    if (tokoriCloud) return 'cloud';
    return 'auto';
  })();

  function applyTarget(t: SaveTargetKey) {
    if (t === 'auto') return patch({ save: { anki: true, tokoriLocal: true, tokoriCloud: true } });
    if (t === 'anki')
      return patch({ save: { anki: true, tokoriLocal: false, tokoriCloud: false } });
    if (t === 'desktop')
      return patch({ save: { anki: false, tokoriLocal: true, tokoriCloud: false } });
    return patch({ save: { anki: false, tokoriLocal: false, tokoriCloud: true } });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Quick settings</CardTitle>
          <CardDescription>
            Set the defaults — every option is also in the full Settings page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Target language
            </Label>
            <Select
              value={settings.defaultTargetLang}
              onValueChange={(v) => patch({ defaultTargetLang: v as LanguageCode })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.name} — {l.nativeName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Used when text language can't be auto-detected. Picking a workspace below updates this
              for you.
            </p>
          </div>

          {cloudWorkspaces.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Tokori cloud workspace
              </Label>
              <Select
                value={settings.cloudWorkspaceId?.toString() ?? ''}
                onValueChange={(v) => v && pickCloudWorkspace(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— pick a workspace —" />
                </SelectTrigger>
                <SelectContent>
                  {cloudWorkspaces.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name} ({w.targetLang})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Cloud saves attach here. Selecting a workspace also sets target language.
              </p>
            </div>
          )}

          {localWorkspaces.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Tokori desktop workspace
              </Label>
              <Select
                value={settings.localWorkspaceId?.toString() ?? ''}
                onValueChange={(v) => v && pickLocalWorkspace(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— pick a workspace —" />
                </SelectTrigger>
                <SelectContent>
                  {localWorkspaces.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name} ({w.target_lang})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Desktop saves attach here. Selecting a workspace also sets target language.
              </p>
            </div>
          )}

          <Separator />

          <ToggleGroupSection
            label="Where to save new vocab"
            value={currentTarget}
            onChange={applyTarget}
            options={[
              { value: 'auto', label: 'All', hint: 'Anki + desktop + cloud' },
              { value: 'anki', label: 'Anki', hint: 'Only AnkiConnect' },
              { value: 'desktop', label: 'Desktop', hint: 'Only Tokori app' },
              { value: 'cloud', label: 'Cloud', hint: 'Only api.tokori.ai' },
            ]}
          />

          <Separator />

          <SwitchRow
            label="Use Tokori desktop AI when available"
            description="Route sentence explanations through the desktop's AI proxy."
            checked={settings.preferDesktopAi}
            onCheckedChange={(v) => patch({ preferDesktopAi: v })}
          />
          <SwitchRow
            label="Use Tokori desktop dictionaries"
            description="Fall back to the desktop's dictionary index when in-browser dicts miss."
            checked={settings.preferDesktopDict}
            onCheckedChange={(v) => patch({ preferDesktopDict: v })}
          />
          <SwitchRow
            label="Auto-detect Tokori desktop"
            description="Probe every minute and re-pair automatically when the app comes online."
            checked={settings.autoDetectDesktop}
            onCheckedChange={(v) => patch({ autoDetectDesktop: v })}
          />
        </CardContent>
      </Card>

      <Alert>
        <AlertCircle className="size-4 text-primary" />
        <AlertTitle>You're set</AlertTitle>
        <AlertDescription>
          Open any page with text in your target language and click a word — the popup will show
          definitions. Visit Settings anytime from the toolbar popup.
        </AlertDescription>
      </Alert>

      <div className="mt-3 flex items-center justify-between">
        <Button onClick={onBack} variant="ghost" size="sm">
          <ArrowLeft data-icon="inline-start" /> Back
        </Button>
        <Button onClick={onFinish} size="lg">
          Finish setup
          <Check data-icon="inline-end" />
        </Button>
      </div>
    </>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ToggleGroupSection<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint: string }>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        className="grid grid-cols-4 gap-1.5"
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.value}
            value={o.value}
            className="flex h-auto flex-col items-center gap-0.5 rounded-md border bg-card/60 px-2 py-2.5 data-[state=on]:border-primary data-[state=on]:bg-primary/10"
          >
            <span className="text-xs font-semibold">{o.label}</span>
            <span className="text-[10px] text-muted-foreground">{o.hint}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Welcome />);
