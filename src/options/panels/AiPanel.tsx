// ── AI keys ───────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Sparkles, ScanText, Check } from 'lucide-react';

import { sendMsgAsync } from '../../lib/chromeApi';
import type { Settings, AiProvider } from '../../lib/settings';
import { getLanguage, type LanguageCode } from '../../lib/languages';
import { DEFAULT_AI_MODELS } from '../../lib/ai-providers';
import { tesseractLangFor } from '../../lib/ocr-cues';

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
import { FieldRow } from '../ui';

export function AiPanel({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const ai = settings.ai;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const modelPlaceholder = ai.provider === 'none' ? '' : DEFAULT_AI_MODELS[ai.provider];

  async function test() {
    setBusy(true);
    setResult(null);
    const samples: Partial<Record<LanguageCode, string>> = {
      zh: '我今天很高兴。',
      ja: '今日はとても楽しかった。',
      ko: '오늘 날씨가 좋네요.',
    };
    const sample = samples[settings.defaultTargetLang] ?? 'Hello, how are you today?';
    const r = await sendMsgAsync<{ data?: { explanation: string } }>({
      action: 'aiExplain',
      text: sample,
      lang: settings.defaultTargetLang,
    });
    if (r.success) {
      setResult({
        ok: true,
        text: (r as { data?: { explanation: string } }).data?.explanation || '(empty response)',
      });
    } else {
      setResult({ ok: false, text: (r as { error?: string }).error || 'Request failed.' });
    }
    setBusy(false);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>AI provider</CardTitle>
          <CardDescription>
            Use your own API key to explain sentences. Keys are stored locally and sent straight to
            the provider — never through Tokori.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldRow label="Provider">
            <Select
              value={ai.provider}
              onValueChange={(v) => patch({ ai: { ...ai, provider: v as AiProvider } })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (use Tokori desktop / cloud)</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="gemini">Google Gemini</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          {ai.provider !== 'none' && (
            <>
              <FieldRow label="API key">
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="Paste your key"
                  value={ai.apiKey ?? ''}
                  onChange={(e) => patch({ ai: { ...ai, apiKey: e.target.value || null } })}
                />
              </FieldRow>
              <FieldRow label="Model">
                <Input
                  placeholder={modelPlaceholder}
                  value={ai.model}
                  onChange={(e) => patch({ ai: { ...ai, model: e.target.value } })}
                />
              </FieldRow>
              <div className="flex items-center gap-3">
                <Button onClick={test} disabled={busy || !ai.apiKey} variant="outline" size="sm">
                  <Sparkles data-icon="inline-start" /> {busy ? 'Testing…' : 'Test'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Runs one explanation on a sample sentence.
                </span>
              </div>
              {result && (
                <Alert variant={result.ok ? 'default' : 'destructive'}>
                  <AlertTitle>{result.ok ? 'Looks good' : 'Request failed'}</AlertTitle>
                  <AlertDescription className="whitespace-pre-wrap">{result.text}</AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {ai.provider === 'none' && (
        <Alert>
          <AlertTitle>No provider selected</AlertTitle>
          <AlertDescription>
            Sentence explanations will use the paired Tokori desktop app or your signed-in cloud
            account, if available.
          </AlertDescription>
        </Alert>
      )}

      <LocalOcrCard settings={settings} patch={patch} />
    </>
  );
}

/** Local OCR engine for the YouTube burned-in-subtitle mode: a
 *  one-time tesseract language-pack download that runs fully in the
 *  browser afterwards — no API key, no per-frame cost. */
function LocalOcrCard({
  settings,
  patch,
}: {
  settings: Settings;
  patch: (p: Partial<Settings>) => Promise<void>;
}) {
  const lang = settings.defaultTargetLang;
  const tessLang = tesseractLangFor(lang);
  const langName = getLanguage(lang)?.name ?? lang;
  const downloaded = !!tessLang && (settings.ocrLocalLangs || []).includes(tessLang);

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The offscreen host broadcasts pack-download progress.
  useEffect(() => {
    const onMsg = (msg: unknown) => {
      const m = msg as { type?: string; progress?: number };
      if (m?.type === 'tokori-local-ocr-progress' && typeof m.progress === 'number') {
        setProgress(m.progress);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  async function download() {
    setDownloading(true);
    setProgress(0);
    setError(null);
    const r = await sendMsgAsync({ action: 'ocrLocalDownload', lang });
    if (!r.success) setError((r as { error?: string }).error || 'Download failed.');
    setDownloading(false);
    setProgress(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local OCR (burned-in subtitles)</CardTitle>
        <CardDescription>
          The YouTube OCR mode reads hardcoded subtitles off the video frame. With the local model
          it runs entirely in your browser — one download per language, then no API key and no
          per-line cost. With an AI key it uses the vision model instead (often more accurate on
          stylised subs).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldRow label="Engine">
          <Select
            value={settings.ocrEngine}
            onValueChange={(v) => patch({ ocrEngine: v as Settings['ocrEngine'] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto — local model when downloaded, else AI key</SelectItem>
              <SelectItem value="local">Local model only (offline, free)</SelectItem>
              <SelectItem value="ai">AI key only</SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>

        <div className="flex items-center gap-3">
          {tessLang ? (
            downloaded ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Check className="size-4 text-[var(--success)]" aria-hidden />
                {langName} model downloaded — local OCR is ready.
              </span>
            ) : (
              <>
                <Button onClick={download} disabled={downloading} variant="outline" size="sm">
                  <ScanText data-icon="inline-start" />
                  {downloading
                    ? progress != null && progress > 0 && progress < 1
                      ? `Downloading… ${Math.round(progress * 100)}%`
                      : 'Downloading…'
                    : `Download ${langName} model`}
                </Button>
                <span className="text-xs text-muted-foreground">
                  One-time, ~10–20 MB — stored in the extension, works offline.
                </span>
              </>
            )
          ) : (
            <span className="text-xs text-muted-foreground">
              No local model is available for {langName} yet — the AI engine still covers it.
            </span>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Download failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
