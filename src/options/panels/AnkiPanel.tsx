// ── Anki ──────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { sendMsgAsync } from '../../lib/chromeApi';
import type { Settings, AnkiMarker } from '../../lib/settings';

import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { FieldRow } from '../ui';

export function AnkiPanel({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function loadAnki() {
    setErr(null);
    const [d, m] = await Promise.all([
      sendMsgAsync<{ decks: string[] }>({ action: 'ankiGetDecks' }),
      sendMsgAsync<{ models: string[] }>({ action: 'ankiGetModels' }),
    ]);
    if (!d.success) setErr((d as { error: string }).error);
    else setDecks((d as { decks: string[] }).decks || []);
    if (!m.success) setErr((m as { error: string }).error);
    else setModels((m as { models: string[] }).models || []);
  }

  useEffect(() => {
    if (settings.anki.model) {
      sendMsgAsync<{ fields: string[] }>({
        action: 'ankiGetModelFields',
        modelName: settings.anki.model,
      }).then((res) => {
        if (res.success) setFields((res as { fields: string[] }).fields || []);
      });
    }
  }, [settings.anki.model]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>AnkiConnect</CardTitle>
          <CardDescription>Requires AnkiConnect running on port 8765.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Button onClick={loadAnki} variant="outline" size="sm">
              <RotateCcw data-icon="inline-start" /> Reload from Anki
            </Button>
            {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
          </div>
          <FieldRow label="Deck">
            <Select
              value={settings.anki.deck}
              onValueChange={(v) => patch({ anki: { ...settings.anki, deck: v } })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[settings.anki.deck, ...decks.filter((d) => d !== settings.anki.deck)]
                  .filter(Boolean)
                  .map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Note type">
            <Select
              value={settings.anki.model}
              onValueChange={(v) => patch({ anki: { ...settings.anki, model: v } })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[settings.anki.model, ...models.filter((m) => m !== settings.anki.model)]
                  .filter(Boolean)
                  .map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      {fields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Field map</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {fields.map((f) => (
              <div key={f} className="grid grid-cols-[140px_1fr] items-center gap-3">
                <Label className="text-sm font-normal">{f}</Label>
                <Select
                  value={settings.anki.fieldMap[f] || ''}
                  onValueChange={(v) =>
                    patch({
                      anki: {
                        ...settings.anki,
                        fieldMap: { ...settings.anki.fieldMap, [f]: v as AnkiMarker },
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— skip —" />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        'word',
                        'reading',
                        'definition',
                        'sentence',
                        'translation',
                        'image',
                        'clip',
                        'sourceUrl',
                      ] as AnkiMarker[]
                    ).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
