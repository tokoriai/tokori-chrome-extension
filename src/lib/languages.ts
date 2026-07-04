/**
 * Language registry. Uses the same language codes as the Tokori app so
 * that anything we send via cloud sync or local IPC lines up with the
 * workspace's `target_lang` codes.
 *
 * Only fields the extension actually uses are included — display name,
 * tokenizer hint, BCP-47 locale, and the dictionary pack id it ships
 * with.
 */

export type LanguageCode =
  | 'zh'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'it'
  | 'pt'
  | 'ru'
  | 'ar'
  | 'hi'
  | 'vi'
  | 'th'
  | 'id'
  | 'tr'
  | 'pl'
  | 'nl'
  | 'sv';

export type TokenizerKind = 'jieba' | 'intl' | 'mecab-stub';

export interface LanguageInfo {
  code: LanguageCode;
  /** Display name in the popup / options UI. */
  name: string;
  /** Native name — useful when listing workspaces from Tokori. */
  nativeName: string;
  /** BCP-47 locale for `Intl.Segmenter` + `SpeechSynthesisUtterance`. */
  locale: string;
  /** Word boundary heuristic. CJK needs a real segmenter; everything
   *  else is fine with `Intl.Segmenter('granularity: word')`. */
  tokenizer: TokenizerKind;
  /** Has a separate phonetic reading (pinyin / kana / IPA). Drives the
   *  ruby / pronunciation row in the hover popup. */
  hasReading: boolean;
  /** Default pack id from `DICTIONARY_PACKS`, or `null` for languages
   *  the user has to set up themselves. */
  recommendedDict: string | null;
}

export const LANGUAGES: LanguageInfo[] = [
  {
    code: 'zh',
    name: 'Chinese',
    nativeName: '中文',
    locale: 'zh-CN',
    tokenizer: 'jieba',
    hasReading: true,
    recommendedDict: 'cc-cedict',
  },
  {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    locale: 'ja-JP',
    tokenizer: 'mecab-stub',
    hasReading: true,
    recommendedDict: 'jmdict-quick',
  },
  {
    code: 'ko',
    name: 'Korean',
    nativeName: '한국어',
    locale: 'ko-KR',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    locale: 'es-ES',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    locale: 'fr-FR',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    locale: 'de-DE',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'it',
    name: 'Italian',
    nativeName: 'Italiano',
    locale: 'it-IT',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    locale: 'pt-PT',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    locale: 'ru-RU',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    locale: 'ar',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    locale: 'hi-IN',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'vi',
    name: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    locale: 'vi-VN',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'th',
    name: 'Thai',
    nativeName: 'ไทย',
    locale: 'th-TH',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'id',
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    locale: 'id-ID',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'tr',
    name: 'Turkish',
    nativeName: 'Türkçe',
    locale: 'tr-TR',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'pl',
    name: 'Polish',
    nativeName: 'Polski',
    locale: 'pl-PL',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'nl',
    name: 'Dutch',
    nativeName: 'Nederlands',
    locale: 'nl-NL',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
  {
    code: 'sv',
    name: 'Swedish',
    nativeName: 'Svenska',
    locale: 'sv-SE',
    tokenizer: 'intl',
    hasReading: false,
    recommendedDict: null,
  },
];

export function getLanguage(code: string): LanguageInfo | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

/** Best-effort guess for which language a string is in. Used by the
 *  hover popup to pick a dict before the user has explicitly named a
 *  target. Only distinguishes the scripts the extension actually
 *  cares about — anything else falls back to the user's configured
 *  default language. */
export function detectLanguage(text: string): LanguageCode | null {
  if (!text) return null;
  // Han characters cover both Chinese and Japanese kanji. Bias towards
  // Japanese if we also see kana, otherwise Chinese.
  const hasHan = /[一-鿿]/.test(text);
  const hasKana = /[぀-ヿ]/.test(text);
  const hasHangul = /[가-힯]/.test(text);
  const hasArabic = /[؀-ۿ]/.test(text);
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const hasDevanagari = /[ऀ-ॿ]/.test(text);
  const hasThai = /[฀-๿]/.test(text);
  if (hasKana) return 'ja';
  if (hasHan) return 'zh';
  if (hasHangul) return 'ko';
  if (hasArabic) return 'ar';
  if (hasCyrillic) return 'ru';
  if (hasDevanagari) return 'hi';
  if (hasThai) return 'th';
  return null;
}
