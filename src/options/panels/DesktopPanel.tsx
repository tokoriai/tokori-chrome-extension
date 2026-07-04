// ── Desktop ───────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';

import { sendMsgAsync } from '../../lib/chromeApi';
import type { Settings } from '../../lib/settings';
import { cn } from '../../lib/utils';

import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { FieldRow, SwitchRow } from '../ui';

export function DesktopPanel({
  settings,
  patch,
  onChange,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pingMsg, setPingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: number; target_lang: string; name: string }>
  >([]);
  const [pairing, setPairing] = useState(false);
  const [pairFallback, setPairFallback] = useState(false);
  const [manualToken, setManualToken] = useState('');

  // Auto-load workspaces whenever we have a token + the desktop is up,
  // so the workspace dropdown is populated without the user clicking
  // "Re-test" first. Also re-runs after a fresh pair / manual paste.
  // If no workspace has been picked yet, default to the first one so
  // saves work immediately instead of failing with "pick a workspace".
  useEffect(() => {
    if (!settings.localApi.token || !settings.desktopOnline) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const ws = await sendMsgAsync<{ workspaces: typeof workspaces }>({
        action: 'localListWorkspaces',
      });
      if (cancelled || !ws.success) return;
      const list = (ws as { workspaces: typeof workspaces }).workspaces || [];
      setWorkspaces(list);
      if (settings.localWorkspaceId == null && list.length > 0) {
        await patch({ localWorkspaceId: list[0].id });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.localApi.token, settings.desktopOnline, settings.localWorkspaceId]);

  async function probe() {
    setBusy(true);
    const ping = await sendMsgAsync<{ ok: boolean }>({ action: 'localPing' });
    const ok = ping.success && (ping as { ok: boolean }).ok;
    setPingMsg({
      ok,
      text: ok ? 'Desktop API reachable.' : 'No response — is the Tokori app running?',
    });
    setBusy(false);
    onChange();
  }

  async function pair() {
    setPairing(true);
    setPairFallback(false);
    setPingMsg({ ok: true, text: 'Waiting for approval in the Tokori desktop app…' });
    const res = await sendMsgAsync({ action: 'desktopPair' });
    setPairing(false);
    if (res.success) {
      setPingMsg({ ok: true, text: 'Paired.' });
      onChange();
    } else {
      // The most common failure: the user's Tokori build doesn't ship
      // /v1/pair/request yet, or they clicked Deny. Surface the manual-
      // paste fallback so they have an unblockable path.
      setPairFallback(true);
      setPingMsg(null);
    }
  }

  async function applyManualToken() {
    const t = manualToken.trim();
    if (!t) return;
    await patch({ localApi: { ...settings.localApi, token: t } });
    setManualToken('');
    setPairFallback(false);
    setPingMsg({ ok: true, text: 'Token saved.' });
    onChange();
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            The desktop app exposes a local API on 127.0.0.1:53210. The token never leaves your
            machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'size-2 rounded-full',
                settings.desktopOnline ? 'bg-success' : 'bg-destructive/70',
              )}
            />
            <span className="text-sm">
              {settings.desktopOnline
                ? settings.localApi.token
                  ? 'Paired with desktop app'
                  : 'Desktop app is running — not paired'
                : 'Desktop app not detected'}
            </span>
            <span className="flex-1" />
            {settings.desktopOnline && !settings.localApi.token && (
              <Button onClick={pair} disabled={pairing} size="sm">
                {pairing ? 'Awaiting approval…' : 'Pair'}
              </Button>
            )}
            <Button onClick={probe} disabled={busy} variant="outline" size="sm">
              {busy ? 'Probing…' : 'Re-test'}
            </Button>
          </div>
          {pingMsg && !pairFallback && (
            <span className={cn('text-xs', pingMsg.ok ? 'text-success' : 'text-destructive')}>
              {pingMsg.text}
            </span>
          )}

          {pairFallback && (
            <Alert>
              <Info className="size-4 text-primary" />
              <AlertTitle>Auto-pair isn't available on this Tokori build</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>
                  Your version of the desktop app doesn't expose the pairing endpoint yet. Open the
                  Tokori desktop app → <strong>Settings → Local API</strong>, copy the token shown
                  there, and paste it below.
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="password"
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                    placeholder="Paste token from desktop app"
                    className="min-w-0 flex-1"
                  />
                  <Button onClick={applyManualToken} disabled={!manualToken.trim()} size="sm">
                    Save token
                  </Button>
                  <Button onClick={() => setPairFallback(false)} variant="ghost" size="sm">
                    Cancel
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SwitchRow
            label="Auto-detect Tokori desktop"
            description="Probe every minute and re-connect when the app comes online."
            checked={settings.autoDetectDesktop}
            onCheckedChange={(v) => patch({ autoDetectDesktop: v })}
          />
          <SwitchRow
            label="Use desktop AI when available"
            description="Route sentence explanations through the desktop's AI proxy (whichever provider you set up there)."
            checked={settings.preferDesktopAi}
            onCheckedChange={(v) => patch({ preferDesktopAi: v })}
          />
          <SwitchRow
            label="Use desktop dictionaries"
            description="Falls back to the desktop's dictionary index when in-browser dicts miss, before hitting the cloud."
            checked={settings.preferDesktopDict}
            onCheckedChange={(v) => patch({ preferDesktopDict: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldRow label="Save to workspace">
            <Select
              value={settings.localWorkspaceId?.toString() ?? ''}
              onValueChange={(v) => patch({ localWorkspaceId: v ? Number(v) : null })}
            >
              <SelectTrigger>
                <SelectValue placeholder="— pick a workspace —" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name} ({w.target_lang})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Advanced</CardTitle>
          <CardDescription>
            You only need to touch this for non-default ports or manual token entry.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldRow label="Base URL">
            <Input
              value={settings.localApi.baseUrl}
              onChange={(e) =>
                patch({ localApi: { ...settings.localApi, baseUrl: e.target.value } })
              }
            />
          </FieldRow>
          <FieldRow label="API token">
            <Input
              type="password"
              value={settings.localApi.token || ''}
              onChange={(e) =>
                patch({ localApi: { ...settings.localApi, token: e.target.value || null } })
              }
              placeholder="auto-filled when you pair"
            />
          </FieldRow>
        </CardContent>
      </Card>
    </>
  );
}
