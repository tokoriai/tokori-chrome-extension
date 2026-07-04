/**
 * Helpers shared by the sentence miner (MiningModal) and the analyzer's
 * inline mining section, factored out so both surfaces produce identical
 * output and save behaviour.
 */
import { sendMsgAsync } from '../lib/chromeApi';
import type { SaveTargets } from '../lib/settings';

/** Wrap the first occurrence of `target` in `sentence` with the chosen
 *  marker — Anki/Tokori cloze (`{{c1::…}}`) or bold (`<b>…</b>`). Returns
 *  the sentence unchanged when `target` is empty or not found. */
export function markSentence(sentence: string, target: string, kind: 'cloze' | 'bold'): string {
  if (!target) return sentence;
  const idx = sentence.indexOf(target);
  if (idx < 0) return sentence;
  const before = sentence.slice(0, idx);
  const after = sentence.slice(idx + target.length);
  const wrapped = kind === 'cloze' ? `{{c1::${target}}}` : `<b>${target}</b>`;
  return `${before}${wrapped}${after}`;
}

/** Push a per-card save-target choice into the per-tab override so the
 *  background's `resolveSaveTargets` honours it for the next save. Fire-
 *  and-forget: on failure we fall back to the global save targets, which
 *  is acceptable degradation. The override resets when the tab closes. */
export async function setTabSaveTargets(targets: SaveTargets): Promise<void> {
  await sendMsgAsync({
    action: 'setTabOverride',
    patch: {
      anki: targets.anki,
      tokoriLocal: targets.tokoriLocal,
      tokoriCloud: targets.tokoriCloud,
    },
  });
}
