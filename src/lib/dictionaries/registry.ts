/**
 * Dictionary pack registry. Flat data only — same pattern Tokori
 * proper uses in `tokori/src/lib/dictionaries/registry.ts`. Each entry
 * declares its language, wire format, and the URL to download from.
 *
 * Adding a new packaged dictionary: append an entry below, and (if
 * the format is new) add the matching parser in this folder.
 *
 * Custom user imports (Yomitan zips, JSON / CSV files) are tracked
 * separately in the same IDB — see `./yomitan.ts` and `./idb.ts`.
 */

import type { LanguageCode } from '../languages';

export type DictFormat =
  /** CEDICT plain-text (`trad simp [pinyin] /def1/def2/`) */
  | 'cedict'
  /** JMdict-quick: a pre-parsed JSON snapshot of JMdict published by
   *  Yomitan; smaller than the official XML and parses in one go. */
  | 'jmdict-quick'
  /** User-supplied Yomitan zip (dictionary metadata + term banks). */
  | 'yomitan'
  /** Plain JSON: `[{ word, reading?, definitions[] }, ...]` */
  | 'json-flat';

export interface DictPack {
  /** Stable id; never change once shipped. */
  id: string;
  lang: LanguageCode;
  name: string;
  description: string;
  format: DictFormat;
  /** Direct download URL. Optional — Yomitan zips come from the user's
   *  file picker, not a URL. */
  url?: string;
  /** Approximate size blurb shown in the install card. */
  sizeBlurb?: string;
  license?: string;
}

export const DICTIONARY_PACKS: DictPack[] = [
  {
    id: 'cc-cedict',
    lang: 'zh',
    name: 'CC-CEDICT',
    description: 'Community-maintained Chinese → English dictionary. ~120k entries.',
    format: 'cedict',
    url: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    sizeBlurb: '~10 MB compressed',
    license: 'CC BY-SA 4.0',
  },
  {
    id: 'jmdict-quick',
    lang: 'ja',
    name: 'JMdict (Yomitan snapshot)',
    description: 'Japanese → English dictionary. Pre-parsed Yomitan snapshot, ~200k entries.',
    format: 'jmdict-quick',
    // GitHub raw URL pointing at a published Yomitan JMdict export.
    // v0.1: if it's missing we surface a "Import from Yomitan zip" hint
    // instead of trying to fail-recover.
    url: 'https://github.com/themoeway/jmdict-yomitan/releases/latest/download/jmdict_english.zip',
    sizeBlurb: '~30 MB compressed',
    license: 'CC BY-SA 4.0',
  },
];

export function packsForLanguage(lang: LanguageCode): DictPack[] {
  return DICTIONARY_PACKS.filter((p) => p.lang === lang);
}

export function packById(id: string): DictPack | undefined {
  return DICTIONARY_PACKS.find((p) => p.id === id);
}
