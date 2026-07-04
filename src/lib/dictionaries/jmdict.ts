/**
 * JMdict installer — re-uses the Yomitan zip importer because the
 * `jmdict-quick` packs we ship are themselves Yomitan-format zips.
 *
 * Keeping a thin wrapper here means `registry.ts` and `background.ts`
 * can dispatch on format without knowing the underlying implementation
 * shares a code path, and it leaves a place to grow if we ever ship a
 * custom-encoded JMdict snapshot.
 */

import { importYomitanZip } from './yomitan';
import type { DictPack } from './registry';
import type { ProgressEvent } from './idb';

export async function installJmdictQuick(
  pack: DictPack,
  onProgress: (p: ProgressEvent) => void,
): Promise<{ entries: number }> {
  if (!pack.url) throw new Error('JMdict-quick pack has no URL');

  onProgress({ phase: 'download', percent: 0 });
  const res = await fetch(pack.url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status}. If the GitHub release moved, import a Yomitan JMdict zip from Settings → Dictionaries instead.`,
    );
  }
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
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  onProgress({ phase: 'download', percent: 100, loaded, total });

  onProgress({ phase: 'parse', percent: 0 });
  const { entries } = await importYomitanZip(new Blob([buf]), pack.lang);
  onProgress({ phase: 'done', percent: 100, entries });
  return { entries };
}
