import { describe, expect, it } from 'vitest';
import { matchesLang, planRestingPick, type PickableTrack } from '../../src/lib/yt-track-pick';

const track = (languageCode: string, extra: Partial<PickableTrack> = {}): PickableTrack => ({
  languageCode,
  vssId: `.${languageCode}`,
  ...extra,
});

/** The player's translate-code resolver, YouTube-flavoured: bare zh is
 *  offered as zh-Hans; everything else resolves to itself. */
const resolveTlang = (target: string) => (target === 'zh' ? 'zh-Hans' : target);

describe('matchesLang', () => {
  it('matches exact and prefixed variants both ways', () => {
    expect(matchesLang('ja', 'ja')).toBe(true);
    expect(matchesLang('pt-BR', 'pt')).toBe(true);
    expect(matchesLang('pt', 'pt-BR')).toBe(true);
    expect(matchesLang('zh-Hans', 'zh')).toBe(true);
  });

  it('treats all Chinese scripts as matching bare zh', () => {
    expect(matchesLang('zh-Hant', 'zh')).toBe(true);
    expect(matchesLang('zh', 'zh-TW')).toBe(true);
  });

  it('rejects unrelated or empty codes', () => {
    expect(matchesLang('en', 'zh')).toBe(false);
    expect(matchesLang('', 'zh')).toBe(false);
    expect(matchesLang('ja', '')).toBe(false);
  });
});

describe('planRestingPick', () => {
  it('rests on the real target-language track when one exists', () => {
    const list = [track('en'), track('ja', { kind: 'asr' })];
    const plan = planRestingPick(list, 'ja', { resolveTlang });
    expect(plan.resting).toEqual({ mode: 'track', track: list[1] });
    expect(plan.hantToHans).toBe(false);
  });

  it('prefers a Simplified track over Traditional for target zh', () => {
    const list = [track('zh-Hant'), track('zh-Hans')];
    const plan = planRestingPick(list, 'zh', { resolveTlang });
    expect(plan.resting).toEqual({ mode: 'track', track: list[1] });
  });

  it('rests on the Hant→Hans translation when only Traditional exists', () => {
    const list = [track('zh-Hant')];
    const plan = planRestingPick(list, 'zh', { resolveTlang });
    expect(plan.resting).toEqual({ mode: 'translate', source: list[0], tlang: 'zh-Hans' });
    expect(plan.hantToHans).toBe(true);
  });

  it('drops to the plain Traditional track once Hant→Hans is disallowed', () => {
    const list = [track('zh-Hant')];
    const plan = planRestingPick(list, 'zh', { resolveTlang, allowHantToHans: false });
    expect(plan.resting).toEqual({ mode: 'track', track: list[0] });
    expect(plan.hantToHans).toBe(false);
  });

  it('stays hands-off (null resting) when no target-language track exists', () => {
    const list = [track('en'), track('ko')];
    const plan = planRestingPick(list, 'zh', { resolveTlang });
    expect(plan.targetTrack).toBeNull();
    expect(plan.resting).toBeNull();
    // The base is still exposed as the source for an EXPLICIT translate
    // pin — it just never drives the automatic pick.
    expect(plan.baseTrack).toBe(list[0]);
  });

  it('prefers a translatable base over a non-translatable English one for pins', () => {
    const list = [track('en', { isTranslatable: false }), track('ko')];
    const plan = planRestingPick(list, 'zh', { resolveTlang });
    expect(plan.baseTrack).toBe(list[1]);
    expect(plan.resting).toBeNull();
  });

  it('honours the legacy is_translateable spelling', () => {
    const list = [track('en', { is_translateable: false }), track('fr')];
    const plan = planRestingPick(list, 'ja', { resolveTlang });
    expect(plan.baseTrack).toBe(list[1]);
  });

  it('still exposes the English base when nothing is translatable', () => {
    const list = [track('en', { isTranslatable: false }), track('ko', { isTranslatable: false })];
    const plan = planRestingPick(list, 'zh', { resolveTlang });
    expect(plan.baseTrack).toBe(list[0]);
    expect(plan.resting).toBeNull();
  });

  it('returns an all-null plan for an empty tracklist', () => {
    const plan = planRestingPick([], 'zh', { resolveTlang });
    expect(plan.resting).toBeNull();
    expect(plan.targetTrack).toBeNull();
    expect(plan.baseTrack).toBeNull();
  });

  it('lowercases the target before matching', () => {
    const list = [track('ja')];
    const plan = planRestingPick(list, 'JA', { resolveTlang });
    expect(plan.resting).toEqual({ mode: 'track', track: list[0] });
  });
});
