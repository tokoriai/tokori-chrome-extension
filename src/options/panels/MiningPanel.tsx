// ── Sentence miner ────────────────────────────────────────────────

import { useState } from 'react';
import { Sparkles } from 'lucide-react';

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
import { Separator } from '../../components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { FieldRow, SwitchRow } from '../ui';

export function MiningPanel({
  settings,
  patch,
  onRefresh,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
  onRefresh: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const m = settings.mining;

  async function installPreset(force = false) {
    setInstalling(true);
    setInstallMsg(null);
    const res = await sendMsgAsync<{
      result?: {
        deckCreated: boolean;
        modelCreated: boolean;
        fieldMapReplaced: boolean;
        modelMissingFields: string[];
      };
    }>({
      action: 'ankiInstallMigakuPreset',
      force,
    });
    setInstalling(false);
    if (!res.success) {
      setInstallMsg({ ok: false, text: (res as { error: string }).error || 'Install failed.' });
      return;
    }
    const r = (
      res as {
        result: {
          deckCreated: boolean;
          modelCreated: boolean;
          fieldMapReplaced: boolean;
          modelMissingFields: string[];
        };
      }
    ).result;
    const parts: string[] = [];
    if (r.deckCreated) parts.push('deck created');
    if (r.modelCreated) parts.push('model created');
    if (r.fieldMapReplaced) parts.push('field map updated');
    if (!parts.length) parts.push('already installed');
    if (r.modelMissingFields.length) {
      setInstallMsg({
        ok: false,
        text: `Model exists but is missing fields: ${r.modelMissingFields.join(', ')}`,
      });
    } else {
      setInstallMsg({ ok: true, text: parts.join(' · ') });
    }
    onRefresh();
  }

  function patchMining(p: Partial<typeof m>) {
    return patch({ mining: { ...m, ...p } });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Capture</CardTitle>
          <CardDescription>
            What the miner attaches to a card when you click <strong>Mine</strong> on a YouTube cue
            or the dict popup.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <SwitchRow
            label="Screenshot"
            description="Grab the current frame as a JPEG and attach it to the card."
            checked={m.screenshotEnabled}
            onCheckedChange={(v) => patchMining({ screenshotEnabled: v })}
          />
          {m.screenshotEnabled && (
            <>
              <FieldRow label="Max width">
                <SliderRow
                  min={320}
                  max={1280}
                  step={40}
                  value={m.screenshotMaxWidth}
                  onChange={(v) => patchMining({ screenshotMaxWidth: v })}
                  suffix="px"
                />
              </FieldRow>
              <FieldRow label="JPEG quality">
                <SliderRow
                  min={0.5}
                  max={0.95}
                  step={0.05}
                  value={m.screenshotQuality}
                  onChange={(v) => patchMining({ screenshotQuality: Number(v.toFixed(2)) })}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
              </FieldRow>
            </>
          )}
          <Separator />
          <SwitchRow
            label="Short clip"
            description="Record a 1–8s WebM clip. Saved as [sound:…] in Anki and clip_data in the Tokori desktop record."
            checked={m.clipEnabled}
            onCheckedChange={(v) => patchMining({ clipEnabled: v })}
          />
          {m.clipEnabled && (
            <>
              <FieldRow label="Default duration">
                <SliderRow
                  min={1}
                  max={8}
                  step={1}
                  value={m.clipDurationSec}
                  onChange={(v) => patchMining({ clipDurationSec: v })}
                  suffix="s"
                />
              </FieldRow>
              <FieldRow label="Max height">
                <SliderRow
                  min={240}
                  max={1080}
                  step={120}
                  value={m.clipMaxHeight}
                  onChange={(v) => patchMining({ clipMaxHeight: v })}
                  suffix="p"
                />
              </FieldRow>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Card defaults</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldRow label="Default card shape">
            <Select
              value={m.defaultCardShape}
              onValueChange={(v) => patchMining({ defaultCardShape: v as 'vocab' | 'sentence' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vocab">Vocab + sentence context (Migaku-style)</SelectItem>
                <SelectItem value="sentence">Sentence card (whole line as the prompt)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Mark studied word as">
            <Select
              value={m.clozeMarker}
              onValueChange={(v) => patchMining({ clozeMarker: v as 'cloze' | 'bold' })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cloze">{'{{c1::word}}'} (Tokori + Anki Cloze)</SelectItem>
                <SelectItem value="bold">{'<b>word</b>'} (any Anki note type)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Anki Migaku-style preset</CardTitle>
          <CardDescription>
            Creates a <code>Tokori::Mining</code> deck and a <code>Tokori Mining</code> note type in
            Anki with fields: Expression, Reading, Meaning, Sentence, SentenceTranslation, Picture,
            Audio, Source. Then maps them to the extension's markers so mined cards land in the
            right slots automatically. Re-running is a no-op.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={() => installPreset(false)} disabled={installing}>
            <Sparkles data-icon="inline-start" />
            {installing ? 'Installing…' : 'Install / refresh preset'}
          </Button>
          {settings.anki.model !== 'Basic' && settings.anki.model !== 'Tokori Mining' && (
            <Button onClick={() => installPreset(true)} variant="outline" disabled={installing}>
              Force overwrite my field map
            </Button>
          )}
          {installMsg && (
            <span className={cn('text-xs', installMsg.ok ? 'text-success' : 'text-destructive')}>
              {installMsg.text}
            </span>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function SliderRow({
  min,
  max,
  step,
  value,
  onChange,
  suffix,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
        {format ? format(value) : `${value}${suffix || ''}`}
      </span>
    </div>
  );
}
