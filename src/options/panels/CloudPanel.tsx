// ── Cloud ─────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';

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
import { Badge } from '../../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { FieldRow } from '../ui';

export function CloudPanel({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: number; name: string; targetLang: string }>
  >([]);
  const [showTokenInput, setShowTokenInput] = useState(false);

  useEffect(() => {
    if (settings.cloud.token) {
      sendMsgAsync<{ workspaces: typeof workspaces }>({ action: 'cloudListWorkspaces' }).then(
        (res) => {
          if (res.success)
            setWorkspaces((res as { workspaces: typeof workspaces }).workspaces || []);
        },
      );
    }
  }, [settings.cloud.token]);

  async function signIn() {
    await sendMsgAsync({ action: 'openCloudAuth' });
  }

  async function signInWithToken() {
    setBusy(true);
    setMsg(null);
    const res = await sendMsgAsync({ action: 'cloudSignIn', token: token.trim() });
    setBusy(false);
    setMsg({ ok: res.success, text: res.success ? 'Signed in' : (res as { error: string }).error });
    if (res.success) setToken('');
  }

  return (
    <>
      {settings.cloud.email ? (
        <Card>
          <CardHeader>
            <CardTitle>Signed in</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                {settings.cloud.email[0]?.toUpperCase()}
              </div>
              <div className="flex-1">
                <div className="font-medium">{settings.cloud.email}</div>
                <div className="text-xs text-muted-foreground">Tokori cloud account</div>
              </div>
              <Badge className="bg-success/15 text-success ring-1 ring-success/30">Connected</Badge>
            </div>
            <FieldRow label="Workspace">
              <Select
                value={settings.cloudWorkspaceId?.toString() ?? ''}
                onValueChange={(v) => patch({ cloudWorkspaceId: v ? Number(v) : null })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="— pick a workspace —" />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name} ({w.targetLang})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            <div>
              <Button
                onClick={async () => {
                  await sendMsgAsync({ action: 'cloudSignOut' });
                  setMsg(null);
                  setToken('');
                }}
                variant="outline"
                size="sm"
              >
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sign in to Tokori</CardTitle>
            <CardDescription>
              Opens the Tokori web app for sign-in. The token comes back to the extension
              automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={signIn}>
                <LogIn data-icon="inline-start" /> Sign in with Tokori
              </Button>
              <Button variant="ghost" onClick={() => setShowTokenInput((s) => !s)}>
                {showTokenInput ? 'Hide token field' : 'Use a paste-in token instead'}
              </Button>
            </div>
            {showTokenInput && (
              <>
                <FieldRow label="Bearer token">
                  <Input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="tk_…"
                  />
                </FieldRow>
                <div className="flex items-center gap-3">
                  <Button onClick={signInWithToken} disabled={busy || !token.trim()}>
                    {busy ? 'Checking…' : 'Sign in with token'}
                  </Button>
                  {msg && (
                    <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-destructive')}>
                      {msg.text}
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>API base</CardTitle>
          <CardDescription>Override for local development.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldRow label="Cloud base URL">
            <Input
              value={settings.cloudApiBase}
              onChange={(e) => patch({ cloudApiBase: e.target.value })}
              placeholder="https://api.tokori.ai"
            />
          </FieldRow>
        </CardContent>
      </Card>
    </>
  );
}
