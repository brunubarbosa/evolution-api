// G3.2 (2026-05-01): wrap globalThis.fetch so we can attribute every
// undici-backed call (Baileys media downloads, profile pics, IQ replies,
// any third-party SDK that uses fetch) to an in-flight entry.
//
// Why: the 2026-04-30 incident gave us an `uncaughtException: terminated`
// from `undici Fetch.onAborted` with no information about WHICH fetch
// broke. This wrapper closes that gap. When undici aborts a request mid-
// flight we can dump the URL via `dumpInFlight()` from the
// uncaughtException handler.
//
// Behavior is identical to the unwrapped fetch — we only sleeve in/out
// hooks that update the in-flight registry, never alter the request,
// response, or rejection.

import { endInFlight, startInFlight } from '@forensic/in-flight';

const FETCH_LOG_THRESHOLD_MS = Number(process.env.FETCH_LOG_THRESHOLD_MS) || 30_000;

let installed = false;

// Side-effect: install on module load so simply `import` of this module
// (placed first in main.ts) wraps fetch before any other module captures
// a reference to the original. The exported `installGlobalFetchInstrument`
// is kept for explicit re-installation in tests.
installGlobalFetchInstrument();

export function installGlobalFetchInstrument() {
  if (installed) return;
  if (typeof globalThis.fetch !== 'function') return;
  installed = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    let method: string;
    try {
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (typeof (input as Request).url === 'string') {
        url = (input as Request).url;
      } else {
        url = String(input);
      }
      method = init?.method || (input as Request)?.method || 'GET';
    } catch {
      url = '<unparseable>';
      method = 'GET';
    }

    const id = startInFlight({
      kind: 'fetch',
      url,
      hint: method,
    });
    const start = Date.now();

    try {
      const result = await originalFetch(input as any, init);
      const elapsed = Date.now() - start;
      if (elapsed >= FETCH_LOG_THRESHOLD_MS) {
        // Lazy-import forensic to avoid a circular load (in-flight is
        // imported above, fine; forensic-logger has no inflight dep).
        const { forensic } = await import('@forensic/forensic-logger');
        let host = '?';
        try {
          host = new URL(url).host;
        } catch {
          /* noop */
        }
        forensic({ kind: 'fetch.slow', url, host, method, durationMs: elapsed }).catch(() => {});
      }
      return result;
    } catch (err) {
      // 2026-05-01 v3.1: capture undici/network errors so the snapshot
      // counter (and observers in instance-tracker) see them, not just
      // slow-but-successful calls. The 04-30 incident's stack pointed at
      // undici Fetch.onAborted with no URL — this fixes that.
      try {
        const e = err as Error & { code?: string; cause?: { message?: string; code?: string } };
        let host = '?';
        try {
          host = new URL(url).host;
        } catch {
          /* noop */
        }
        const { forensic } = await import('@forensic/forensic-logger');
        forensic({
          kind: 'fetch.error',
          url,
          host,
          method,
          durationMs: Date.now() - start,
          message: e?.message,
          name: e?.name,
          code: e?.code,
          causeMessage: e?.cause?.message,
          causeCode: e?.cause?.code,
        }).catch(() => {});
      } catch {
        /* never break the request path over forensic IO */
      }
      throw err;
    } finally {
      endInFlight(id);
    }
  }) as typeof fetch;
}
