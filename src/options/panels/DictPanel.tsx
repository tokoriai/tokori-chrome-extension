// ── Dictionaries ──────────────────────────────────────────────────

import { useState } from 'react';
import { Upload, FileJson, Trash2 } from 'lucide-react';

import { sendMsgAsync } from '../../lib/chromeApi';
import type { Settings } from '../../lib/settings';
import { LANGUAGES, type LanguageCode } from '../../lib/languages';
import { DICTIONARY_PACKS, type DictPack } from '../../lib/dictionaries/registry';
import type { DictMeta, ProgressEvent } from '../../lib/dictionaries/idb';
import { installCedict } from '../../lib/dictionaries/cedict';
import { installJmdictQuick } from '../../lib/dictionaries/jmdict';
import { importYomitanZip, importFlatJson } from '../../lib/dictionaries/yomitan';

import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

export function DictPanel({
  settings,
  installed,
  onChange,
}: {
  settings: Settings;
  installed: DictMeta[];
  onChange: () => void;
}) {
  const [progress, setProgress] = useState<Record<string, ProgressEvent | null>>({});
  /** Which language a custom import belongs to. Defaults to the user's
   *  target but is freely switchable — a zh learner can still install a
   *  Japanese dictionary without touching their default. */
  const [importLang, setImportLang] = useState<LanguageCode>(settings.defaultTargetLang);

  async function install(pack: DictPack) {
    setProgress((p) => ({ ...p, [pack.id]: { phase: 'download', percent: 0 } }));
    try {
      if (pack.format === 'cedict') {
        await installCedict(pack, (ev) => setProgress((p) => ({ ...p, [pack.id]: ev })));
      } else if (pack.format === 'jmdict-quick') {
        await installJmdictQuick(pack, (ev) => setProgress((p) => ({ ...p, [pack.id]: ev })));
      }
      setProgress((p) => ({ ...p, [pack.id]: { phase: 'done', percent: 100 } }));
      onChange();
    } catch (e) {
      setProgress((p) => ({
        ...p,
        [pack.id]: {
          phase: 'error',
          percent: 0,
          message: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  async function uninstall(dictId: string) {
    await sendMsgAsync({ action: 'dictDelete', dictId });
    onChange();
  }

  async function importYomitan(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importYomitanZip(file, importLang);
      onChange();
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function importFlat(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, '');
    try {
      await importFlatJson(file, importLang, name);
      onChange();
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Packaged dictionaries</CardTitle>
          <CardDescription>Once installed, lookups run fully offline.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {DICTIONARY_PACKS.map((pack) => (
            <PackRow
              key={pack.id}
              pack={pack}
              isInstalled={installed.some((m) => m.dictId === pack.id)}
              progress={progress[pack.id] || null}
              onInstall={() => install(pack)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Installed</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {installed.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing installed yet.</p>
          )}
          {installed.map((m) => (
            <div
              key={m.dictId}
              className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{m.name}</div>
                <div className="text-xs text-muted-foreground">
                  {m.lang} · {m.format} · {m.entries.toLocaleString()} entries · installed{' '}
                  {new Date(m.version).toLocaleDateString()}
                </div>
              </div>
              <Button onClick={() => uninstall(m.dictId)} variant="outline" size="sm">
                <Trash2 data-icon="inline-start" /> Remove
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Import custom</CardTitle>
          <CardDescription>
            Yomitan zips work as-is. For a flat word list, use CSV/TSV (word [, reading],
            definition) or JSON array of {`{ word, reading?, definitions[] }`}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Language</span>
            <Select value={importLang} onValueChange={(v) => setImportLang(v as LanguageCode)}>
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label>
            <Button asChild>
              <span>
                <Upload data-icon="inline-start" /> Import Yomitan zip…
              </span>
            </Button>
            <input type="file" accept=".zip" onChange={importYomitan} className="hidden" />
          </label>
          <label>
            <Button asChild variant="outline">
              <span>
                <FileJson data-icon="inline-start" /> Import JSON/CSV…
              </span>
            </Button>
            <input
              type="file"
              accept=".json,.csv,.tsv,.txt"
              onChange={importFlat}
              className="hidden"
            />
          </label>
          <span className="text-xs text-muted-foreground">
            Everything imports into the browser's own database — no Tokori account or desktop app
            needed.
          </span>
        </CardContent>
      </Card>
    </>
  );
}

function PackRow({
  pack,
  isInstalled,
  progress,
  onInstall,
}: {
  pack: DictPack;
  isInstalled: boolean;
  progress: ProgressEvent | null;
  onInstall: () => void;
}) {
  const inProgress = progress && progress.phase !== 'done' && progress.phase !== 'error';
  return (
    <div className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{pack.name}</span>
          {isInstalled && (
            <Badge className="bg-success/15 text-success ring-1 ring-success/30">Installed</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {pack.lang} · {pack.description} · {pack.sizeBlurb || '—'}
        </div>
        {progress && progress.phase !== 'done' && progress.phase !== 'error' && (
          <div className="mt-1 text-xs text-primary">
            {progress.phase}… {progress.percent ? `${progress.percent}%` : ''}
            {progress.entries ? ` (${progress.entries.toLocaleString()} entries)` : ''}
          </div>
        )}
        {progress?.phase === 'done' && (
          <div className="mt-1 text-xs text-success">
            Installed {progress.entries?.toLocaleString()} entries.
          </div>
        )}
        {progress?.phase === 'error' && (
          <div className="mt-1 text-xs text-destructive">Error: {progress.message}</div>
        )}
      </div>
      <Button onClick={onInstall} disabled={!!inProgress} size="sm">
        {inProgress ? 'Working…' : isInstalled ? 'Reinstall' : 'Install'}
      </Button>
    </div>
  );
}
