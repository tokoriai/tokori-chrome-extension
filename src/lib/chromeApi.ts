/**
 * Safe wrappers around chrome.* APIs.
 *
 * MV3 service workers can be torn down at any time, and the content
 * script's bridge to them is the first thing to break when the
 * extension is updated mid-session. These wrappers swallow the
 * lifecycle errors and surface a structured `{ success: false }`
 * payload instead, so call sites never have to babysit
 * `chrome.runtime.lastError`.
 */

export type Response<T = Record<string, unknown>> =
  ({ success: true } & T) | { success: false; error: string; errorCode?: string };

export function sendMsg<T = unknown>(
  msg: Record<string, unknown>,
  callback?: (response: Response<T>) => void,
): void {
  try {
    if (!chrome?.runtime?.id) {
      callback?.({ success: false, error: 'Extension context invalidated' });
      return;
    }
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        callback?.({ success: false, error: chrome.runtime.lastError.message || 'unknown' });
        return;
      }
      callback?.(res);
    });
  } catch (e) {
    callback?.({ success: false, error: String(e) });
  }
}

export function sendMsgAsync<T = unknown>(msg: Record<string, unknown>): Promise<Response<T>> {
  return new Promise((resolve) => sendMsg<T>(msg, resolve));
}

export function storageGet<T = Record<string, unknown>>(
  keys: string | string[] | null,
): Promise<T> {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local) return resolve({} as T);
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) return resolve({} as T);
        resolve(items as T);
      });
    } catch {
      resolve({} as T);
    }
  });
}

export function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local) return resolve();
      chrome.storage.local.set(items, () => resolve());
    } catch {
      resolve();
    }
  });
}
