// ── About ─────────────────────────────────────────────────────────

import { Info, RotateCcw } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';

export function AboutPanel({ onChange }: { onChange: () => void }) {
  async function resetAll() {
    if (
      !confirm(
        'Clear all extension settings, tokens, and per-tab overrides? Dictionaries stay installed.',
      )
    )
      return;
    await chrome.storage.local.clear();
    await chrome.storage.session?.clear();
    onChange();
    alert('Reset.');
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Tokori Companion</CardTitle>
          <CardDescription>
            Version {chrome.runtime.getManifest().version} · local-first.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Issues or feature requests:{' '}
          <a
            className="text-primary hover:underline"
            href="https://github.com/tokoriai/tokori-chrome-extension/issues"
            target="_blank"
            rel="noreferrer"
          >
            github.com/tokoriai/tokori-extension
          </a>
        </CardContent>
      </Card>

      <Alert>
        <Info className="size-4 text-primary" />
        <AlertTitle>Reset</AlertTitle>
        <AlertDescription>
          Clears settings, tokens, and per-tab overrides. Dictionaries you installed in your browser
          stay.
        </AlertDescription>
      </Alert>
      <div>
        <Button onClick={resetAll} variant="destructive">
          <RotateCcw data-icon="inline-start" /> Reset everything
        </Button>
      </div>
    </>
  );
}
