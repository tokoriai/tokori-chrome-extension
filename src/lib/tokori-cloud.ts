/**
 * Tokori cloud client. Talks to api.tokori.ai — the same multi-tenant
 * REST surface the hosted web app (`app.tokori.ai`) uses.
 *
 * Auth: bearer token. Issued by `/v1/auth/sign-in` (magic link in
 * production, but for v0.1 we accept a paste-in token from the
 * Tokori web app's Account → Devices panel — easier than implementing
 * the full magic-link flow inside a Chrome extension).
 *
 * Errors: thrown as `CloudHttpError` so callers can branch on status.
 */

/* Base URL is passed in by callers — the background service worker
 * reads `cloudApiBase` from settings and forwards it. Keeps this
 * module pure + makes local-dev pointing at `localhost:3001`
 * trivial. */
import type { LanguageCode } from './languages';

export class CloudHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudHttpError';
  }
}

function buildHeaders(token: string | null, extra?: HeadersInit): HeadersInit {
  const h = new Headers(extra);
  if (token) h.set('authorization', `Bearer ${token}`);
  if (!h.has('content-type')) h.set('content-type', 'application/json');
  return h;
}

async function expect<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {}
    throw new CloudHttpError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────

export interface CloudAccount {
  token: string;
  email: string;
  /** Optional: server may return the user's default workspace id so
   *  the extension can resolve `cloudWorkspaceId` without a second
   *  round-trip. */
  defaultWorkspaceId?: number;
}

/** v0.1: paste-in token flow. Calls `/v1/me` to validate the token and
 *  pull the email + default workspace. Magic-link → token exchange is
 *  deferred until the extension grows a proper sign-in UI. */
export async function validateToken(baseUrl: string, token: string): Promise<CloudAccount> {
  const res = await fetch(`${baseUrl}/v1/me`, {
    headers: buildHeaders(token),
  });
  if (res.status === 401)
    throw new CloudHttpError(401, 'Token rejected — copy a fresh one from your Tokori account.');
  const me = await expect<{ email: string; defaultWorkspaceId?: number }>(res);
  return { token, email: me.email, defaultWorkspaceId: me.defaultWorkspaceId };
}

// ── Workspaces ────────────────────────────────────────────────────

export interface CloudWorkspace {
  id: number;
  targetLang: LanguageCode;
  nativeLang: string;
  name: string;
}

export async function listWorkspaces(baseUrl: string, token: string): Promise<CloudWorkspace[]> {
  const res = await fetch(`${baseUrl}/v1/workspaces`, {
    headers: buildHeaders(token),
  });
  return expect<CloudWorkspace[]>(res);
}

// ── Dict (public, no auth) ────────────────────────────────────────

export interface DictHit {
  word: string;
  reading?: string;
  definitions: string[];
}

/** Cloud dict search — public endpoint, no token needed. Mirrors the
 *  shape used by `src/app/api/v1/dict/search/route.ts` in tokori-cloud. */
export async function dictSearch(
  baseUrl: string,
  lang: LanguageCode,
  query: string,
): Promise<DictHit[]> {
  const url = new URL(`${baseUrl}/v1/dict/search`);
  url.searchParams.set('lang', lang);
  url.searchParams.set('q', query);
  const res = await fetch(url.toString());
  return expect<DictHit[]>(res);
}

// ── Vocab ─────────────────────────────────────────────────────────

export interface CloudVocabRow {
  id: number;
  word: string;
  reading: string | null;
  gloss: string | null;
  status: string;
}

/** List a workspace's vocab (word + SRS status). Powers known-word
 *  highlighting for cloud-only users the same way the desktop's
 *  `listVocab` does for paired ones. The endpoint returns every row;
 *  media fields are already stripped server-side. */
export async function listVocab(
  baseUrl: string,
  token: string,
  workspaceId: number,
): Promise<CloudVocabRow[]> {
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/vocab`, {
    headers: buildHeaders(token),
  });
  const data = await expect<{ vocab: CloudVocabRow[] }>(res);
  return data.vocab || [];
}

export type VocabStatus = 'new' | 'learning' | 'review' | 'mastered';

/** Upsert a word with an explicit SRS status — the cloud twin of the
 *  desktop's `POST /v1/vocab/status`. Two steps because the cloud API
 *  splits the concerns: POST upserts the row by (workspace, word)
 *  without touching an existing schedule, then PATCH force-sets the
 *  status (the POST-side `srsState` seed is ignored for rows with
 *  review history — it exists for backup restores, not for grading). */
export async function setVocabStatus(
  baseUrl: string,
  token: string,
  input: {
    workspaceId: number;
    word: string;
    reading?: string;
    gloss?: string;
    status: VocabStatus;
  },
): Promise<{ id: number; status: VocabStatus }> {
  const upsertRes = await fetch(`${baseUrl}/v1/workspaces/${input.workspaceId}/vocab`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      word: input.word,
      reading: input.reading,
      gloss: input.gloss,
      source: 'extension',
    }),
  });
  const upserted = await expect<{ vocab: { id: number; status: string } }>(upsertRes);
  const id = upserted.vocab.id;
  if (upserted.vocab.status === input.status) return { id, status: input.status };
  const patchRes = await fetch(`${baseUrl}/v1/workspaces/${input.workspaceId}/vocab/${id}`, {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify({ status: input.status }),
  });
  const patched = await expect<{ vocab: { id: number; status: string } }>(patchRes);
  return { id: patched.vocab.id, status: patched.vocab.status as VocabStatus };
}

export interface CreateVocabInput {
  workspaceId: number;
  word: string;
  reading?: string;
  definition?: string;
  sentence?: string;
  translation?: string;
  sourceUrl?: string;
  tags?: string[];
}

export async function createVocab(
  baseUrl: string,
  token: string,
  input: CreateVocabInput,
): Promise<{ id: number }> {
  const { workspaceId, ...body } = input;
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/vocab`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  return expect<{ id: number }>(res);
}

// ── Collections ("+ List" in the word popup) ──────────────────────

export interface CloudCollection {
  id: number;
  name: string;
  isDefault: boolean;
  wordCount?: number;
}

export async function listCollections(
  baseUrl: string,
  token: string,
  workspaceId: number,
): Promise<CloudCollection[]> {
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/collections`, {
    headers: buildHeaders(token),
  });
  const data = await expect<{ collections: CloudCollection[] }>(res);
  return data.collections || [];
}

export async function createCollection(
  baseUrl: string,
  token: string,
  workspaceId: number,
  name: string,
): Promise<CloudCollection> {
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/collections`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ name }),
  });
  const data = await expect<{ collection: CloudCollection }>(res);
  return data.collection;
}

/** Upsert the word into the workspace and link it into the collection —
 *  same idempotent semantics as the desktop's add-words route. */
export async function addWordToCollection(
  baseUrl: string,
  token: string,
  input: {
    workspaceId: number;
    collectionId: number;
    word: string;
    reading?: string;
    gloss?: string;
  },
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/v1/workspaces/${input.workspaceId}/collections/${input.collectionId}/words`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify({
        word: input.word,
        reading: input.reading ?? null,
        gloss: input.gloss ?? null,
      }),
    },
  );
  await expect<{ vocab: { id: number } }>(res);
}

// ── TTS (Edge voices proxied by the cloud) ────────────────────────
//
// `/ai/v1/tts/edge` is auth-optional: anonymous callers are allowed but
// rate-limited per IP, signed-in callers get the generous cap. Pass the
// bearer token when we have one; callers should treat any failure as
// "fall back to the browser's speechSynthesis".

export async function ttsEdge(
  baseUrl: string,
  token: string | null,
  input: { text: string; voice: string; rate?: string },
): Promise<{ audio: string; mime: string }> {
  const res = await fetch(`${baseUrl}/ai/v1/tts/edge`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ text: input.text, voice: input.voice, rate: input.rate }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await expect<{ audio: string }>(res);
  if (!data.audio) throw new CloudHttpError(502, 'TTS returned no audio.');
  return { audio: data.audio, mime: 'audio/mpeg' };
}

// ── Chat completions (account-billed AI) ─────────────────────────
//
// OpenAI-compatible SSE proxy. Used as the last hop of the extension's
// AI fallback chain (BYO key → desktop → cloud). We read the streamed
// body to completion and return the concatenated text — the extension's
// one-shot callers (generate definition) don't need token streaming.

export async function chatComplete(
  baseUrl: string,
  token: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/ai/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({ messages, stream: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string | { message?: string } };
      const e = body?.error;
      msg = (typeof e === 'string' ? e : e?.message) || msg;
    } catch {}
    throw new CloudHttpError(res.status, msg);
  }
  const raw = await res.text();
  // Non-streamed JSON body (in case the proxy answered without SSE).
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { choices?: { message?: { content?: string } }[] };
      const text = j.choices?.[0]?.message?.content;
      if (text) return text;
    } catch {}
  }
  // OpenAI-style SSE frames: `data: {"choices":[{"delta":{"content":…}}]}`.
  let out = '';
  for (const line of raw.split('\n')) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : null;
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload) as {
        choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      };
      out += j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
    } catch {
      /* keep-alive / comment frame */
    }
  }
  if (!out.trim()) throw new CloudHttpError(502, 'Cloud AI returned an empty response.');
  return out;
}

// ── Library (videos + articles imported from the extension) ───────

export type LibraryKind = 'video' | 'article' | 'book' | 'podcast';

export interface CreateLibraryItemInput {
  workspaceId: number;
  kind: LibraryKind;
  title: string;
  url: string;
  /** Optional duration (videos) or word count (articles). */
  durationSec?: number;
  wordCount?: number;
  /** Source — "youtube", "netflix", "manual". */
  source?: string;
  /** Cover / thumbnail. */
  thumbnailUrl?: string;
}

export async function createLibraryItem(
  baseUrl: string,
  token: string,
  input: CreateLibraryItemInput,
): Promise<{ id: number }> {
  const { workspaceId, ...body } = input;
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/library`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  return expect<{ id: number }>(res);
}

// ── Reader docs (long-form text the user wants to read in Tokori) ──

export interface CreateReaderDocInput {
  workspaceId: number;
  title: string;
  body: string;
  sourceUrl?: string;
  language: LanguageCode;
}

export async function createReaderDoc(
  baseUrl: string,
  token: string,
  input: CreateReaderDocInput,
): Promise<{ id: number }> {
  const { workspaceId, ...body } = input;
  const res = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/reader-docs`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  return expect<{ id: number }>(res);
}

// ── AI explain (cloud-served) ─────────────────────────────────────
//
// The cloud uses the user's account-level AI quota / billing. The
// extension just hands off the text and target language and gets back
// a single explanation string — same shape as the desktop's
// /v1/ai/explain so callers don't branch on transport.

export interface AiExplainResult {
  explanation: string;
  model?: string;
}

export async function aiExplain(
  baseUrl: string,
  token: string,
  input: { text: string; lang: LanguageCode },
): Promise<AiExplainResult> {
  const res = await fetch(`${baseUrl}/v1/ai/explain`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(input),
  });
  return expect<AiExplainResult>(res);
}
