/**
 * CC-CEDICT downloader, parser, indexer.
 *
 * Ported from hanpanda's `lib/cedict.ts` with two changes:
 *  • writes into the multi-dict `tokori-dicts` IDB layout via `idb.ts`
 *    so multiple dicts (CEDICT + Yomitan packs + custom JSON) coexist;
 *  • normalised pinyin lands in *both* surface and reading indices so
 *    a learner who pastes "ni hao" gets a hit even though CC-CEDICT
 *    keys on simplified / traditional only.
 */

import { indexDict, type DictEntry, type DictMeta, type ProgressEvent } from './idb';
import type { DictPack } from './registry';

const TONE_MAP: Record<string, string> = {
  a: 'āáǎàa',
  e: 'ēéěèe',
  i: 'īíǐìi',
  o: 'ōóǒòo',
  u: 'ūúǔùu',
  v: 'ǖǘǚǜü',
};

export function syllableToMarks(s: string): string {
  if (!s || !/\d/.test(s[s.length - 1])) return s;
  const tone = parseInt(s[s.length - 1], 10);
  s = s.slice(0, -1).toLowerCase().replace(/u:/g, 'v');
  // Any 'v' that doesn't end up carrying the tone mark must still render
  // as ü — "lu:e4" is lüè, not lvè.
  const finish = (marked: string) => marked.replace(/v/g, 'ü');
  // CEDICT writes neutral tone as 5; some other sources use 0.
  if (tone < 1 || tone > 4) return finish(s);
  const n = tone - 1;
  for (const [search, markOn] of [
    ['a', 'a'],
    ['e', 'e'],
    ['ou', 'o'],
  ] as const) {
    if (s.includes(search)) return finish(s.replace(markOn, TONE_MAP[markOn][n]));
  }
  for (let i = s.length - 1; i >= 0; i--) {
    if (TONE_MAP[s[i] as keyof typeof TONE_MAP]) {
      return finish(s.slice(0, i) + TONE_MAP[s[i] as keyof typeof TONE_MAP][n] + s.slice(i + 1));
    }
  }
  return finish(s);
}

export function diacriticPinyin(pyRaw: string): string {
  return pyRaw.split(' ').map(syllableToMarks).join(' ');
}

function strippedPinyin(pyRaw: string): string {
  // Lowercase, drop tone numbers, drop spaces. Used as a reading key
  // so "ni hao", "nihao", "nĭ hǎo" all collide on the same bucket.
  return pyRaw.toLowerCase().replace(/\d/g, '').replace(/u:/g, 'ü').replace(/\s+/g, '');
}

export interface CedictParseResult {
  bySurface: Map<string, DictEntry[]>;
  byReading: Map<string, DictEntry[]>;
  matched: number;
  skipped: number;
}

/** Parse CC-CEDICT text (canonical `trad simp [pinyin] /def/def/` lines)
 *  into surface- and reading-keyed entry maps. Comment lines (`#`) and
 *  malformed lines are skipped. Pure — no IDB, no network — so it can be
 *  unit tested directly. `onProgress` is called every ~8k lines. */
export function parseCedictLines(
  text: string,
  onProgress?: (done: number, total: number, entries: number) => void,
): CedictParseResult {
  const pat = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/$/;
  const lines = text.split(/\r?\n/);
  const bySurface = new Map<string, DictEntry[]>();
  const byReading = new Map<string, DictEntry[]>();
  let matched = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charCodeAt(0) === 35 /* '#' */) continue;
    const m = line.match(pat);
    if (!m) {
      skipped++;
      continue;
    }
    matched++;
    const [, trad, simp, pyRaw, defsRaw] = m;
    const entry: DictEntry = {
      word: simp,
      reading: diacriticPinyin(pyRaw),
      definitions: defsRaw.split('/').filter(Boolean),
    };
    if (!bySurface.has(simp)) bySurface.set(simp, []);
    bySurface.get(simp)!.push(entry);
    if (trad !== simp) {
      if (!bySurface.has(trad)) bySurface.set(trad, []);
      bySurface.get(trad)!.push(entry);
    }
    const rk = strippedPinyin(pyRaw);
    if (rk) {
      if (!byReading.has(rk)) byReading.set(rk, []);
      byReading.get(rk)!.push(entry);
    }
    if (onProgress && (i & 0x1fff) === 0) onProgress(i, lines.length, bySurface.size);
  }
  return { bySurface, byReading, matched, skipped };
}

export async function installCedict(
  pack: DictPack,
  onProgress: (p: ProgressEvent) => void,
): Promise<{ entries: number }> {
  if (!pack.url) throw new Error('CEDICT pack has no URL');

  // 1. Stream-download
  onProgress({ phase: 'download', percent: 0 });
  const res = await fetch(pack.url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = Date.now();
    if (total && now - lastReport > 100) {
      onProgress({
        phase: 'download',
        percent: Math.min(100, Math.round((loaded / total) * 100)),
        loaded,
        total,
      });
      lastReport = now;
    }
  }
  const gz = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    gz.set(c, off);
    off += c.byteLength;
  }
  onProgress({ phase: 'download', percent: 100, loaded, total });

  // 2. Decompress
  onProgress({ phase: 'decompress', percent: 0 });
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  void w.write(gz);
  void w.close();
  const dr = ds.readable.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  while (true) {
    const { done, value } = await dr.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  // 3. Parse — canonical CEDICT format: `trad simp [pinyin] /def/def/`
  const { bySurface, byReading, matched, skipped } = parseCedictLines(
    text,
    (done, total, entries) => {
      onProgress({
        phase: 'parse',
        percent: Math.min(99, Math.round((done / total) * 100)),
        entries,
      });
    },
  );
  onProgress({ phase: 'parse', percent: 100, entries: bySurface.size });
  if (bySurface.size === 0) {
    throw new Error(
      `CEDICT parse produced 0 entries (matched=${matched}, skipped=${skipped}). Format may have changed — please report.`,
    );
  }

  // 4. Index — single transaction
  const meta: DictMeta = {
    dictId: pack.id,
    lang: pack.lang,
    name: pack.name,
    format: 'cedict',
    entries: bySurface.size,
    version: new Date().toISOString(),
  };
  onProgress({ phase: 'index', percent: 0, entries: bySurface.size });
  await indexDict({ meta, bySurface, byReading });
  onProgress({ phase: 'done', percent: 100, entries: bySurface.size });

  return { entries: bySurface.size };
}
