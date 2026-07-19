/**
 * AI providers.
 *
 * Two surfaces live here:
 *
 *  1. `explain()` — bring-your-own-key sentence explanations. When the
 *     user configures a provider + API key in Options, requests go
 *     **straight to the provider** (OpenAI / Anthropic / Gemini) from
 *     the background service worker. Keys are never proxied through
 *     Tokori, and the calls require the matching `host_permissions`.
 *     If no key is configured, the background worker falls back to the
 *     paired desktop app or signed-in cloud account instead.
 *
 *  2. `freeTranslate()` — a dead-simple, no-key Google Translate
 *     fallback for the "translate sentence" affordance, which works
 *     without auth and rate-limits politely. Same trick hanpanda uses.
 */

import { getLanguage, type LanguageCode } from './languages';
import type { AiProvider } from './settings';

export class AiProviderError extends Error {
  constructor(
    message: string,
    public provider: AiProvider,
    public status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Sensible, widely-available default model per provider. The user can
 *  override any of these in the Options → AI panel. */
export const DEFAULT_AI_MODELS: Record<Exclude<AiProvider, 'none'>, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-1.5-flash',
};

export interface ExplainInput {
  provider: AiProvider;
  apiKey: string;
  /** Empty / omitted → the provider's default model. */
  model?: string;
  text: string;
  lang: LanguageCode;
}

export interface ExplainResult {
  explanation: string;
  provider: AiProvider;
  model: string;
}

function buildPrompt(text: string, lang: LanguageCode): { system: string; user: string } {
  const language = getLanguage(lang)?.name ?? lang;
  const system =
    `You are a concise language tutor. The learner is studying ${language}. ` +
    'Explain the given sentence clearly and briefly:\n' +
    '1. A natural English translation.\n' +
    '2. A short gloss of the key words or phrases.\n' +
    '3. One or two notes on grammar or usage worth knowing.\n' +
    'Keep it compact and skimmable. Do not repeat the full sentence back.';
  return { system, user: text };
}

/** Parse a provider response, throwing a typed `AiProviderError` that
 *  carries the provider's own error message when the call failed. */
async function parseOrThrow<T>(res: Response, provider: Exclude<AiProvider, 'none'>): Promise<T> {
  const raw = (await res.json().catch(() => null)) as
    (T & { error?: { message?: string } | string }) | null;
  if (!res.ok) {
    const e = raw?.error;
    const msg = (typeof e === 'string' ? e : e?.message) || `HTTP ${res.status}`;
    throw new AiProviderError(msg, provider, res.status);
  }
  if (!raw) throw new AiProviderError('Empty response from provider.', provider, res.status);
  return raw as T;
}

interface ChatCall {
  apiKey: string;
  system: string;
  user: string;
}

async function chatOpenAi(input: ChatCall, model: string): Promise<string> {
  const { system, user } = input;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseOrThrow<{
    choices?: { message?: { content?: string } }[];
  }>(res, 'openai');
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new AiProviderError('OpenAI returned an empty response.', 'openai', res.status);
  return text;
}

async function chatAnthropic(input: ChatCall, model: string): Promise<string> {
  const { system, user } = input;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calls made directly from a browser/extension context.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseOrThrow<{ content?: { type: string; text?: string }[] }>(
    res,
    'anthropic',
  );
  const text = data.content
    ?.map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim();
  if (!text)
    throw new AiProviderError('Anthropic returned an empty response.', 'anthropic', res.status);
  return text;
}

async function chatGemini(input: ChatCall, model: string): Promise<string> {
  const { system, user } = input;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseOrThrow<{
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  }>(res, 'gemini');
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new AiProviderError('Gemini returned an empty response.', 'gemini', res.status);
  return text;
}

/** One-shot chat completion against the user's own provider key.
 *  Shared by `explain()` and the "Generate definition" flow. */
export async function chatOnce(input: {
  provider: AiProvider;
  apiKey: string | null;
  model?: string;
  system: string;
  user: string;
}): Promise<{ text: string; model: string }> {
  if (input.provider === 'none') {
    throw new AiProviderError('No AI provider configured.', 'none');
  }
  if (!input.apiKey) {
    throw new AiProviderError('No API key set for the selected provider.', input.provider);
  }
  const model = input.model?.trim() || DEFAULT_AI_MODELS[input.provider];
  const call: ChatCall = { apiKey: input.apiKey, system: input.system, user: input.user };
  let text: string;
  switch (input.provider) {
    case 'openai':
      text = await chatOpenAi(call, model);
      break;
    case 'anthropic':
      text = await chatAnthropic(call, model);
      break;
    case 'gemini':
      text = await chatGemini(call, model);
      break;
  }
  return { text, model };
}

// ── Vision (image → text) ─────────────────────────────────────────
//
// One-shot image+prompt completion, used by the burned-in-subtitle
// OCR. Same BYO-key rules as `chatOnce`; the default models above are
// all vision-capable.

function splitDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) throw new Error('Expected a base64 data: URL.');
  return { mediaType: m[1]!, base64: m[2]! };
}

export async function visionOnce(input: {
  provider: AiProvider;
  apiKey: string | null;
  model?: string;
  system: string;
  user: string;
  imageDataUrl: string;
}): Promise<{ text: string; model: string }> {
  if (input.provider === 'none') {
    throw new AiProviderError('No AI provider configured.', 'none');
  }
  if (!input.apiKey) {
    throw new AiProviderError('No API key set for the selected provider.', input.provider);
  }
  const model = input.model?.trim() || DEFAULT_AI_MODELS[input.provider];
  const { mediaType, base64 } = splitDataUrl(input.imageDataUrl);

  if (input.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: input.user },
              { type: 'image_url', image_url: { url: input.imageDataUrl, detail: 'low' } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await parseOrThrow<{ choices?: { message?: { content?: string } }[] }>(
      res,
      'openai',
    );
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text == null)
      throw new AiProviderError('OpenAI returned an empty response.', 'openai', res.status);
    return { text, model };
  }

  if (input.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: input.system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: input.user },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await parseOrThrow<{ content?: { type: string; text?: string }[] }>(
      res,
      'anthropic',
    );
    const text = data.content
      ?.map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join('')
      .trim();
    if (text == null)
      throw new AiProviderError('Anthropic returned an empty response.', 'anthropic', res.status);
    return { text, model };
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: mediaType, data: base64 } }, { text: input.user }],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 300 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await parseOrThrow<{
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  }>(res, 'gemini');
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim();
  if (text == null)
    throw new AiProviderError('Gemini returned an empty response.', 'gemini', res.status);
  return { text, model };
}

/** Explain a sentence using the user's own provider key. Throws
 *  `AiProviderError` on misconfiguration or a provider failure. */
export async function explain(input: ExplainInput): Promise<ExplainResult> {
  const { system, user } = buildPrompt(input.text, input.lang);
  const { text, model } = await chatOnce({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    system,
    user,
  });
  return { explanation: text, provider: input.provider, model };
}

// ── Generate definition ───────────────────────────────────────────
//
// Prompt + parser for the "no dictionary entry → ask the AI" flow,
// ported from the desktop's word-popover so both surfaces produce the
// same JSON shape. The caller picks the transport (BYO key via
// `chatOnce`, desktop `/v1/chat/stream`, or cloud chat completions)
// and funnels the raw reply through `parseDefineResponse`.

export interface DefineResult {
  word: string;
  reading: string | null;
  gloss: string;
  examples: Array<{ target: string; native?: string }>;
}

export function buildDefinePrompt(
  word: string,
  lang: LanguageCode,
): { system: string; user: string } {
  const info = getLanguage(lang);
  const targetName = info?.name ?? lang;
  const wantsReading = !!info?.hasReading;
  const readingHint = wantsReading
    ? `"reading": "<phonetic reading (pinyin / furigana / etc.) — empty string if not applicable>",`
    : `"reading": "",`;
  const system =
    `You are a concise bilingual dictionary. Reply with ONE JSON ` +
    `object only — no prose, no markdown fences. Keep the gloss ` +
    `under 120 characters. If the word has multiple senses, ` +
    `separate them with "; ". Provide TWO short example ` +
    `sentences that show the word in natural usage. Each ` +
    `example MUST include a ${targetName} sentence and its ` +
    `English translation. Do NOT add explanations, ` +
    `etymology, or any extra fields.`;
  const user =
    `Define this ${targetName} word for an English speaker.\n\n` +
    `Word: ${word}\n\n` +
    `Reply with JSON shaped exactly:\n` +
    `{\n` +
    `  "word": "${word}",\n` +
    `  ${readingHint}\n` +
    `  "gloss": "<short English translation>",\n` +
    `  "examples": [\n` +
    `    { "target": "<${targetName} sentence using ${word}>", "native": "<English translation of that sentence>" },\n` +
    `    { "target": "<another ${targetName} sentence using ${word}>", "native": "<English translation>" }\n` +
    `  ]\n` +
    `}`;
  return { system, user };
}

/** Defensive parse of the model's reply. Strips markdown fences and any
 *  prose around the JSON object; accepts any examples shape that has a
 *  string `target` and drops the rest. Throws on missing gloss. */
export function parseDefineResponse(raw: string, word: string): DefineResult {
  const cleaned = raw
    .replace(/```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const jsonStr = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let parsed: { reading?: unknown; gloss?: unknown; examples?: unknown };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("AI didn't return valid JSON. Try a different provider?");
  }
  const reading =
    typeof parsed.reading === 'string' && parsed.reading.trim() ? parsed.reading.trim() : null;
  const gloss = typeof parsed.gloss === 'string' ? parsed.gloss.trim() : '';
  if (!gloss) throw new Error("AI didn't return a gloss.");
  const examples: DefineResult['examples'] = [];
  if (Array.isArray(parsed.examples)) {
    for (const row of parsed.examples) {
      if (examples.length >= 5) break;
      if (!row || typeof row !== 'object') continue;
      const r = row as { target?: unknown; native?: unknown };
      const t = typeof r.target === 'string' ? r.target.trim() : '';
      const n = typeof r.native === 'string' ? r.native.trim() : '';
      if (!t) continue;
      examples.push(n ? { target: t, native: n } : { target: t });
    }
  }
  return { word, reading, gloss, examples };
}

export async function freeTranslate(
  text: string,
  from: LanguageCode,
  to: string = 'en',
): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url);
  const data = await r.json();
  if (Array.isArray(data?.[0])) {
    return data[0].map((row: unknown[]) => row[0] || '').join('');
  }
  return '';
}
