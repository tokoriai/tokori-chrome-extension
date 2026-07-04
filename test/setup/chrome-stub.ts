/**
 * Minimal in-memory stub of the `chrome.storage` surface the extension
 * uses, installed as a Vitest setup file. Each test starts from a clean
 * slate (the areas are reset in `beforeEach`). Tests that need to seed or
 * inspect stored state can import { chromeStub } from this module.
 */
import { beforeEach } from 'vitest';

type Store = Record<string, unknown>;
type Keys = string | string[] | Record<string, unknown> | null | undefined;

function createArea() {
  let data: Store = {};
  return {
    get(keys?: Keys): Promise<Store> {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === 'string') {
        return Promise.resolve(keys in data ? { [keys]: data[keys] } : {});
      }
      if (Array.isArray(keys)) {
        const out: Store = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return Promise.resolve(out);
      }
      const out: Store = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? data[k] : def;
      return Promise.resolve(out);
    },
    set(items: Store): Promise<void> {
      data = { ...data, ...items };
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      return Promise.resolve();
    },
    clear(): Promise<void> {
      data = {};
      return Promise.resolve();
    },
    _reset(): void {
      data = {};
    },
  };
}

const local = createArea();
const session = createArea();

(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local,
    session,
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: { id: 'test-extension-id' },
};

beforeEach(() => {
  local._reset();
  session._reset();
});

export const chromeStub = { local, session };
