/**
 * Tiny logging helper used across the extension.
 *
 * `warn` / `error` always fire (prefixed so they're easy to spot in the
 * service-worker console). `debug` is silent unless debugging is opted
 * into — set `globalThis.TOKORI_DEBUG = true` from the service-worker
 * devtools console, or `localStorage.TOKORI_DEBUG = '1'` in a page /
 * options context. This keeps day-to-day consoles quiet without losing
 * the ability to trace issues when something misbehaves.
 */

const PREFIX = '[Tokori]';

function debugEnabled(): boolean {
  try {
    if ((globalThis as { TOKORI_DEBUG?: boolean }).TOKORI_DEBUG) return true;
    return typeof localStorage !== 'undefined' && localStorage.getItem('TOKORI_DEBUG') === '1';
  } catch {
    return false;
  }
}

export function debug(...args: unknown[]): void {
  if (debugEnabled()) console.debug(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
