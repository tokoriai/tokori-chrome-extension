import { describe, it, expect } from 'vitest';
import { buildDefinePrompt, parseDefineResponse } from '@/lib/ai-providers';

describe('parseDefineResponse', () => {
  const word = '吃货';

  it('parses a clean JSON reply', () => {
    const raw = JSON.stringify({
      word,
      reading: 'chī huò',
      gloss: 'foodie; chowhound',
      examples: [{ target: '他是个吃货。', native: 'He is a foodie.' }],
    });
    const out = parseDefineResponse(raw, word);
    expect(out).toEqual({
      word,
      reading: 'chī huò',
      gloss: 'foodie; chowhound',
      examples: [{ target: '他是个吃货。', native: 'He is a foodie.' }],
    });
  });

  it('strips markdown fences the model adds despite instructions', () => {
    const raw = '```json\n{"word":"吃货","reading":"","gloss":"foodie","examples":[]}\n```';
    expect(parseDefineResponse(raw, word).gloss).toBe('foodie');
  });

  it('recovers the JSON object from surrounding prose', () => {
    const raw =
      'Sure! Here you go:\n{"word":"吃货","reading":null,"gloss":"foodie"}\nHope that helps.';
    const out = parseDefineResponse(raw, word);
    expect(out.gloss).toBe('foodie');
    expect(out.reading).toBeNull();
  });

  it('normalises a blank reading to null', () => {
    const raw = '{"word":"x","reading":"  ","gloss":"g"}';
    expect(parseDefineResponse(raw, word).reading).toBeNull();
  });

  it('throws on invalid JSON', () => {
    expect(() => parseDefineResponse('not json at all', word)).toThrow(/valid JSON/);
  });

  it('throws when the gloss is missing or empty', () => {
    expect(() => parseDefineResponse('{"word":"x","reading":""}', word)).toThrow(/gloss/);
    expect(() => parseDefineResponse('{"gloss":"   "}', word)).toThrow(/gloss/);
  });

  it('drops malformed example rows and caps the list at 5', () => {
    const raw = JSON.stringify({
      gloss: 'g',
      examples: [
        { target: 'a', native: 'A' },
        { native: 'missing target' },
        'not an object',
        { target: '' },
        { target: 'b' }, // native optional
        { target: 'c', native: 'C' },
        { target: 'd', native: 'D' },
        { target: 'e', native: 'E' },
        { target: 'f', native: 'F' },
      ],
    });
    const out = parseDefineResponse(raw, word);
    expect(out.examples).toHaveLength(5);
    expect(out.examples[0]).toEqual({ target: 'a', native: 'A' });
    expect(out.examples[1]).toEqual({ target: 'b' });
  });

  it('tolerates a non-array examples field', () => {
    const raw = '{"gloss":"g","examples":"none"}';
    expect(parseDefineResponse(raw, word).examples).toEqual([]);
  });
});

describe('buildDefinePrompt', () => {
  it('names the word and the target language', () => {
    const { system, user } = buildDefinePrompt('吃货', 'zh');
    expect(system).toContain('bilingual dictionary');
    expect(user).toContain('吃货');
    expect(user).toContain('Chinese');
  });

  it('asks for a phonetic reading only for languages that have one', () => {
    expect(buildDefinePrompt('吃货', 'zh').user).toContain('phonetic reading');
    expect(buildDefinePrompt('Haus', 'de').user).toContain('"reading": ""');
  });
});
