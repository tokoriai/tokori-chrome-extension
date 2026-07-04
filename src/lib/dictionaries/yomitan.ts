/**
 * Yomitan-format zip importer.
 *
 * Yomitan dictionaries are zip files containing `index.json` + one or
 * more `term_bank_N.json` (and optionally kanji / term-meta banks).
 * Each term-bank entry is an 8-element array, with the relevant
 * fields being:
 *
 *   [0] expression  — the surface form (kanji+kana for Japanese)
 *   [1] reading     — phonetic reading (kana, pinyin, …)
 *   [5] definitions — array of strings or structured-content nodes
 *
 * We intentionally skip the kanji banks + structured-content
 * normalisation in v0.1 — a flattened text gloss is plenty for the
 * hover popup, and the user can always upgrade to Yomitan proper if
 * they want the full surface.
 *
 * No external zip library is bundled — we use the browser's built-in
 * DecompressionStream + a tiny zip reader implementation lifted from
 * Yomitan's own approach. zips here are local-deflate-stored entries
 * (Yomitan dicts use level-9 deflate), no encryption, no spanning.
 */

import { indexDict, type DictEntry, type DictMeta } from './idb';
import type { LanguageCode } from '../languages';

/** Tiny zip reader: handles the subset of zip features that real
 *  Yomitan dictionaries actually use (DEFLATE + STORE, no encryption,
 *  no zip64). Built on DecompressionStream so we don't ship pako. */
async function readZip(blob: Blob): Promise<Map<string, Uint8Array>> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // End of Central Directory signature: 0x06054b50, scanned from end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');
  const entryCount = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);

  const out = new Map<string, Uint8Array>();
  let p = cdOff;
  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Bad central dir entry');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    void cdSize;
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Read the local file header at localOff to find the actual data offset.
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('Bad local header');
    const lhNameLen = dv.getUint16(localOff + 26, true);
    const lhExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lhNameLen + lhExtraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);

    if (method === 0) {
      out.set(name, compressed);
    } else if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const merged = new Uint8Array(uncompSize);
      let o = 0;
      for (const c of chunks) {
        merged.set(c, o);
        o += c.byteLength;
      }
      out.set(name, merged);
    } else {
      throw new Error(`Unsupported compression method ${method} for ${name}`);
    }
  }
  return out;
}

interface YomitanIndex {
  title: string;
  format?: number;
  version?: number;
  revision?: string;
  /** Two-letter source-language code. Yomitan calls it
   *  `sourceLanguage`; pre-format-3 dictionaries used `language`. */
  sourceLanguage?: string;
  language?: string;
  targetLanguage?: string;
}

type YomitanTerm = [
  expression: string,
  reading: string,
  _definitionTags: string | null,
  _rules: string,
  _score: number,
  glossary: Array<string | Record<string, unknown>>,
  _sequence: number,
  _termTags: string,
];

function flattenGloss(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  // Yomitan structured-content: { type: 'structured-content', content: ... }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.content)) return obj.content.map(flattenGloss).join('');
  if (typeof obj.content === 'string') return obj.content;
  if (typeof obj.text === 'string') return obj.text;
  return '';
}

export async function importYomitanZip(
  file: Blob,
  /** Override the source language if `index.json` doesn't declare it
   *  (older Yomitan dicts). */
  langHint?: LanguageCode,
): Promise<{ dictId: string; entries: number; meta: DictMeta }> {
  const files = await readZip(file);
  const indexBytes = files.get('index.json');
  if (!indexBytes) throw new Error('Zip is missing index.json — not a Yomitan dictionary');
  const indexText = new TextDecoder().decode(indexBytes);
  const index = JSON.parse(indexText) as YomitanIndex;
  const lang = (index.sourceLanguage || index.language || langHint || '') as LanguageCode;
  if (!lang)
    throw new Error(
      'Cannot infer dictionary language; pass langHint or use a Yomitan dict with sourceLanguage set.',
    );

  const bySurface = new Map<string, DictEntry[]>();
  const byReading = new Map<string, DictEntry[]>();

  for (const [name, bytes] of files) {
    if (!/^term_bank_\d+\.json$/.test(name)) continue;
    const arr = JSON.parse(new TextDecoder().decode(bytes)) as YomitanTerm[];
    for (const row of arr) {
      const [expr, reading, , , , glossary] = row;
      if (!expr) continue;
      const definitions = glossary.map(flattenGloss).filter(Boolean);
      if (definitions.length === 0) continue;
      const entry: DictEntry = { word: expr, reading: reading || undefined, definitions };
      if (!bySurface.has(expr)) bySurface.set(expr, []);
      bySurface.get(expr)!.push(entry);
      if (reading && reading !== expr) {
        if (!byReading.has(reading)) byReading.set(reading, []);
        byReading.get(reading)!.push(entry);
      }
    }
  }

  // Custom dicts namespace under "user:<slug>" so they never collide
  // with packaged-pack ids in the registry.
  const slug = (index.title || 'yomitan-import')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const dictId = `user:${slug || 'yomitan'}-${Date.now()}`;
  const meta: DictMeta = {
    dictId,
    lang,
    name: index.title || 'Imported Yomitan dictionary',
    format: 'yomitan',
    entries: bySurface.size,
    version: new Date().toISOString(),
  };
  await indexDict({ meta, bySurface, byReading });
  return { dictId, entries: bySurface.size, meta };
}

/** Plain JSON / CSV / TSV importer. Hand-rolled, deliberately small —
 *  the user's "I exported my own list" case. */
export async function importFlatJson(
  file: Blob,
  lang: LanguageCode,
  name: string,
): Promise<{ dictId: string; entries: number; meta: DictMeta }> {
  const text = await file.text();
  const rows: Array<{ word: string; reading?: string; definitions: string[] }> = (() => {
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed) as Array<{
        word: string;
        reading?: string;
        definitions?: string[];
        definition?: string;
      }>;
      return parsed.map((r) => ({
        word: r.word,
        reading: r.reading,
        definitions: r.definitions ?? (r.definition ? [r.definition] : []),
      }));
    }
    // CSV / TSV — auto-detect separator on the first line.
    const sep = trimmed.includes('\t') ? '\t' : ',';
    const out: typeof rows = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = line.split(sep);
      if (parts.length < 2) continue;
      const [word, b, c] = parts;
      // 2-col: word, definition. 3-col: word, reading, definition.
      out.push(
        c !== undefined ? { word, reading: b, definitions: [c] } : { word, definitions: [b] },
      );
    }
    return out;
  })();

  const bySurface = new Map<string, DictEntry[]>();
  const byReading = new Map<string, DictEntry[]>();
  for (const r of rows) {
    if (!r.word) continue;
    const entry: DictEntry = { word: r.word, reading: r.reading, definitions: r.definitions };
    if (!bySurface.has(r.word)) bySurface.set(r.word, []);
    bySurface.get(r.word)!.push(entry);
    if (r.reading && r.reading !== r.word) {
      if (!byReading.has(r.reading)) byReading.set(r.reading, []);
      byReading.get(r.reading)!.push(entry);
    }
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const dictId = `user:${slug || 'custom'}-${Date.now()}`;
  const meta: DictMeta = {
    dictId,
    lang,
    name,
    format: 'json-flat',
    entries: bySurface.size,
    version: new Date().toISOString(),
  };
  await indexDict({ meta, bySurface, byReading });
  return { dictId, entries: bySurface.size, meta };
}
