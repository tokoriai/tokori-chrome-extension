/**
 * Anki preset installer — creates a Migaku-style deck + note model in
 * the user's Anki via AnkiConnect, then writes the matching `fieldMap`
 * into the extension's settings so subsequent mining "just works".
 *
 * Idempotent: re-running is a no-op once everything exists.
 *
 * The model layout is the standard sentence-mining template the
 * Japanese-Mining-Notes / Migaku / Anime-Cards communities have
 * converged on, so users moving over from those tools find what they
 * expect.
 */

import { ac } from './anki';
import { patchSettings, type AnkiMarker, type AnkiConfig } from './settings';

export const PRESET_DECK = 'Tokori::Mining';
export const PRESET_MODEL = 'Tokori Mining';

export const PRESET_FIELD_MAP: Record<string, AnkiMarker> = {
  Expression: 'word',
  Reading: 'reading',
  Meaning: 'definition',
  Sentence: 'sentence',
  SentenceTranslation: 'translation',
  Picture: 'image',
  Audio: 'clip',
  Source: 'sourceUrl',
};

const PRESET_FIELDS = Object.keys(PRESET_FIELD_MAP);

/** Card template — mirrors the Migaku/JPMN convention: front shows the
 *  sentence with the expression bolded + picture; back reveals reading
 *  + meaning + translation + audio. Styled cleanly enough to work in
 *  both desktop and mobile Anki without further tweaking. */
const PRESET_CARD = {
  Name: 'Tokori Mining',
  Front: '<div class="picture">{{Picture}}</div>\n' + '<div class="sentence">{{Sentence}}</div>',
  Back:
    '{{FrontSide}}\n' +
    '<hr id="answer">\n' +
    '<div class="expression">{{Expression}}</div>\n' +
    '<div class="reading">{{Reading}}</div>\n' +
    '<div class="meaning">{{Meaning}}</div>\n' +
    '<div class="translation">{{SentenceTranslation}}</div>\n' +
    '<div class="audio">{{Audio}}</div>\n' +
    '<div class="source">{{Source}}</div>',
};

const PRESET_CSS = `
.card { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 20px; color: #1f1f1f; background: #fafafa; padding: 16px; }
.card.nightMode { background: #1b1d22; color: #e9eaec; }
.picture img { max-width: 100%; max-height: 320px; border-radius: 8px; display: block; margin: 0 auto 12px; }
.sentence { font-size: 24px; line-height: 1.45; text-align: center; margin: 12px 0; }
.expression { font-size: 28px; font-weight: 600; text-align: center; margin-top: 8px; }
.reading { color: #b27a40; font-size: 18px; text-align: center; margin-top: 4px; }
.meaning { font-size: 16px; line-height: 1.5; margin-top: 12px; }
.translation { font-size: 15px; color: #6c6f78; margin-top: 8px; }
.audio { margin-top: 12px; }
.source { font-size: 11px; color: #888; margin-top: 16px; text-align: center; }
hr#answer { margin: 16px 0; border: none; border-top: 1px solid #ddd; }
b, strong { color: #b27a40; }
`;

export interface InstallResult {
  deckCreated: boolean;
  modelCreated: boolean;
  modelMissingFields: string[];
  /** True when the field-map in settings was overwritten with the
   *  Migaku defaults. The caller can warn the user if they had a
   *  custom mapping they wanted to keep. */
  fieldMapReplaced: boolean;
}

/** Install the Migaku-style deck + model into Anki and update the
 *  extension's saved `anki` config to use them. Safe to call multiple
 *  times. */
export async function installMigakuPreset(opts: {
  /** Existing config — used to decide whether to overwrite the
   *  fieldMap. We replace only when the user is still on the default
   *  `Basic` model, so users with custom setups aren't clobbered. */
  current: AnkiConfig;
  /** Force overwrite even if the user has a non-default model. */
  force?: boolean;
}): Promise<InstallResult> {
  const decks = await ac<string[]>('deckNames').catch(() => [] as string[]);
  const deckCreated = !decks.includes(PRESET_DECK);
  if (deckCreated) {
    await ac('createDeck', { deck: PRESET_DECK });
  }

  const models = await ac<string[]>('modelNames').catch(() => [] as string[]);
  const modelCreated = !models.includes(PRESET_MODEL);
  if (modelCreated) {
    await ac('createModel', {
      modelName: PRESET_MODEL,
      inOrderFields: PRESET_FIELDS,
      css: PRESET_CSS,
      cardTemplates: [PRESET_CARD],
    });
  }

  // Verify the model has all the fields we expect — if the user
  // edited it in Anki we shouldn't silently break their fieldMap.
  const fields = await ac<string[]>('modelFieldNames', { modelName: PRESET_MODEL }).catch(
    () => [] as string[],
  );
  const modelMissingFields = PRESET_FIELDS.filter((f) => !fields.includes(f));

  const canReplaceMap =
    opts.force || opts.current.model === 'Basic' || opts.current.model === PRESET_MODEL;

  let fieldMapReplaced = false;
  if (canReplaceMap) {
    await patchSettings({
      anki: {
        deck: PRESET_DECK,
        model: PRESET_MODEL,
        fieldMap: { ...PRESET_FIELD_MAP },
      },
    });
    fieldMapReplaced = true;
  }

  return { deckCreated, modelCreated, modelMissingFields, fieldMapReplaced };
}
