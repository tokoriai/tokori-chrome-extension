// ── General ───────────────────────────────────────────────────────

import type { Settings } from '../../lib/settings';
import { LANGUAGES, type LanguageCode } from '../../lib/languages';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { FieldRow, SwitchRow } from '../ui';

export function GeneralPanel({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldRow label="Target language">
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
          </FieldRow>
          <FieldRow label="Trigger">
            <Select
              value={settings.triggerMode}
              onValueChange={(v) => patch({ triggerMode: v as 'click' | 'hover' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="click">Click selection</SelectItem>
                <SelectItem value="hover">Hover (experimental)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Mode">
            <Select
              value={settings.mode}
              onValueChange={(v) => patch({ mode: v as 'local' | 'cloud' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local (offline-first)</SelectItem>
                <SelectItem value="cloud">Cloud (sync with Tokori account)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default save targets</CardTitle>
          <CardDescription>Per-tab overrides live in the popup.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SwitchRow
            label="Anki"
            description="Push cards via AnkiConnect on localhost:8765."
            checked={settings.save.anki}
            onCheckedChange={(v) => patch({ save: { ...settings.save, anki: v } })}
          />
          <SwitchRow
            label="Tokori desktop"
            description="Send vocab to the desktop app's workspace."
            checked={settings.save.tokoriLocal}
            onCheckedChange={(v) => patch({ save: { ...settings.save, tokoriLocal: v } })}
          />
          <SwitchRow
            label="Tokori cloud"
            description="Sync to your account at api.tokori.ai."
            checked={settings.save.tokoriCloud}
            onCheckedChange={(v) => patch({ save: { ...settings.save, tokoriCloud: v } })}
          />
        </CardContent>
      </Card>
    </>
  );
}
