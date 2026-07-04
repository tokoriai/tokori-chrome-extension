import { describe, it, expect } from 'vitest';
import {
  getSettings,
  resolveSaveTargets,
  getTabOverride,
  setTabOverride,
  DEFAULT_SETTINGS,
  type SaveTargets,
} from '@/lib/settings';
import { chromeStub } from '../setup/chrome-stub';

describe('getSettings', () => {
  it('returns the defaults for an empty store', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-merges a partial nested object over its defaults', async () => {
    await chromeStub.local.set({ save: { anki: false } });
    const s = await getSettings();
    expect(s.save).toEqual({ anki: false, tokoriLocal: false, tokoriCloud: false });
  });

  it('keeps default anki fields when only one is stored', async () => {
    await chromeStub.local.set({ anki: { deck: 'Mining' } });
    const s = await getSettings();
    expect(s.anki.deck).toBe('Mining');
    expect(s.anki.model).toBe(DEFAULT_SETTINGS.anki.model);
    expect(s.anki.fieldMap).toEqual(DEFAULT_SETTINGS.anki.fieldMap);
  });

  it('deep-merges the mining and ai configs', async () => {
    await chromeStub.local.set({ mining: { clipDurationSec: 7 }, ai: { provider: 'openai' } });
    const s = await getSettings();
    expect(s.mining.clipDurationSec).toBe(7);
    expect(s.mining.clipEnabled).toBe(DEFAULT_SETTINGS.mining.clipEnabled);
    expect(s.ai).toEqual({ provider: 'openai', apiKey: null, model: '' });
  });

  it('passes through unknown top-level keys', async () => {
    await chromeStub.local.set({ somethingNew: 1 });
    const s = (await getSettings()) as unknown as Record<string, unknown>;
    expect(s.somethingNew).toBe(1);
  });
});

describe('resolveSaveTargets', () => {
  const global: SaveTargets = { anki: true, tokoriLocal: false, tokoriCloud: false };

  it('returns the global targets when there is no override', () => {
    expect(resolveSaveTargets(global, null)).toBe(global);
  });

  it('falls back to global for each null override field', () => {
    expect(
      resolveSaveTargets(global, { anki: null, tokoriLocal: null, tokoriCloud: null }),
    ).toEqual(global);
  });

  it('applies non-null override fields', () => {
    expect(
      resolveSaveTargets(global, { anki: false, tokoriLocal: null, tokoriCloud: true }),
    ).toEqual({
      anki: false,
      tokoriLocal: false,
      tokoriCloud: true,
    });
  });
});

describe('getTabOverride / setTabOverride', () => {
  it('returns null for a tab with no override', async () => {
    expect(await getTabOverride(99)).toBeNull();
  });

  it('seeds a new override with nulls for unspecified fields', async () => {
    await setTabOverride(5, { anki: true });
    expect(await getTabOverride(5)).toEqual({ anki: true, tokoriLocal: null, tokoriCloud: null });
  });

  it('merges successive patches', async () => {
    await setTabOverride(5, { anki: true });
    await setTabOverride(5, { tokoriCloud: false });
    expect(await getTabOverride(5)).toEqual({ anki: true, tokoriLocal: null, tokoriCloud: false });
  });

  it('deletes an override when patched with null', async () => {
    await setTabOverride(5, { anki: true });
    await setTabOverride(5, null);
    expect(await getTabOverride(5)).toBeNull();
  });

  it('keeps overrides for different tabs independent', async () => {
    await setTabOverride(1, { anki: true });
    await setTabOverride(2, { anki: false });
    expect((await getTabOverride(1))?.anki).toBe(true);
    expect((await getTabOverride(2))?.anki).toBe(false);
  });
});
