/**
 * PostHog Error Tracking router for the Evolution API.
 *
 * Hooks into the existing forensic event stream (subscribeForensic) and
 * forwards a curated allowlist of "real incidents" to the same PostHog
 * project used by GDW + the moderation worker. Tagged `runtime:
 * evolution-api` so all three layers share one issue list.
 *
 * Design choices:
 *   - Single subscriber, no instrumentation of individual call sites.
 *     The 50+ `forensic({ kind: ... })` sites and 299 `logger.error()`
 *     sites are not touched.
 *   - Aggressive allowlist (FORWARD_KINDS): only structural failures
 *     reach PostHog. Noisy events (webhook.delivery, heartbeat, mutex
 *     timeouts, normal reconnects) stay on disk in the forensic JSONL.
 *   - Per-(kind, instance) rate limit on RATE_LIMITED_KINDS to defang
 *     storms (e.g. a flapping instance firing autoheal.error in a loop).
 *   - PII goes through the shared sanitizer that mirrors the GDW twins.
 *   - No-op when POSTHOG_API_KEY is unset (dev, preview, etc.).
 */

import { type ForensicEvent, subscribeForensic } from '@forensic/forensic-logger';
import { PostHog } from 'posthog-node';

import { sanitizeContext } from './sanitize';

// Structural failures that warrant a human looking at PostHog. Tune by
// editing this constant — keep the list short.
const FORWARD_KINDS = new Set<string>([
  // Process-level catastrophes (already snapshotted to forensic)
  'process.uncaughtException',
  'process.unhandledRejection',
  // Autoheal escalations — instance unable to recover on its own
  'autoheal.permanent-stop',
  'autoheal.giveup',
  'autoheal.error',
  'autoheal.reinit.failed',
  // Reconnect anomalies — short flicker is normal, sustained flapping is not
  'reconnect.flapping',
  'reconnect.fastpath.error',
  // Heartbeat-detected silent failures
  'zombie.suspected',
  'pipeline.stalled',
  // Database failures
  'prisma.timeout',
  'prisma.error',
  // Baileys event-handler errors caught by Evolution's wrapper
  'baileys.handler.error',
  // Fastify/Express 5xx routed via the boundary helper (kind: 'http.5xx')
  'http.5xx',
  // Chatbot integration crashes
  'chatbot.precheck.error',
  // Manual debug actions that crash (rare, but worth seeing)
  'debug.forceclose.error',
]);

// Kinds that can fire in storms — apply a 5-minute window per (kind, instance).
const RATE_LIMITED_KINDS = new Set<string>([
  'baileys.handler.error',
  'autoheal.error',
  'autoheal.giveup',
  'reconnect.flapping',
  'http.5xx',
]);
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const lastForwarded = new Map<string, number>();

const API_KEY = process.env.POSTHOG_API_KEY;
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const RELEASE = process.env.RELEASE_VERSION || process.env.SOURCE_COMMIT || process.env.GIT_SHA || 'unknown';

let client: PostHog | null = null;
let unsubscribe: (() => void) | null = null;

function getClient(): PostHog | null {
  if (!API_KEY) return null;
  if (client) return client;
  client = new PostHog(API_KEY, {
    host: HOST,
    // We control which events fire via the allowlist; uncaughtException is
    // already captured upstream via the forensic process handlers.
    enableExceptionAutocapture: false,
    flushAt: 1,
    flushInterval: 0,
  });
  return client;
}

function shouldForward(event: ForensicEvent): boolean {
  if (!FORWARD_KINDS.has(event.kind)) return false;
  if (!RATE_LIMITED_KINDS.has(event.kind)) return true;

  const bucket = `${event.kind}:${event.instance ?? '_global'}`;
  const now = Date.now();
  const last = lastForwarded.get(bucket);
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return false;
  lastForwarded.set(bucket, now);
  return true;
}

function buildError(event: ForensicEvent): Error {
  // Prefer existing error metadata if the forensic event carried one
  // (process.uncaughtException, baileys.handler.error). Otherwise synth
  // an Error from the kind so PostHog has a stack frame to group on.
  const detail = event.detail as { message?: string; stack?: string } | undefined;
  const msg = (event.error as { message?: string } | undefined)?.message || detail?.message || String(event.kind);
  const err = new Error(msg);
  err.name = event.kind;
  const stack = (event.error as { stack?: string } | undefined)?.stack || detail?.stack;
  if (stack && typeof stack === 'string') err.stack = stack;
  return err;
}

/**
 * Forward a single forensic event to PostHog if it passes the filters.
 * Synchronous — never awaits the network call (posthog-node buffers).
 * Never throws (catches everything; observability must never break the app).
 */
export function routeForensicToPosthog(event: ForensicEvent): void {
  const c = getClient();
  if (!c) return;
  if (!shouldForward(event)) return;
  try {
    const props = {
      runtime: 'evolution-api',
      release: RELEASE,
      kind: event.kind,
      instance: event.instance ?? null,
      ...sanitizeContext(event as Record<string, unknown>),
    };
    c.captureException(buildError(event), undefined, props);
  } catch {
    /* never let observability break the hot path */
  }
}

/**
 * Capture an error directly (used by the Express 5xx middleware and the
 * Baileys-event wrapper in whatsapp.baileys.service.ts). Bypasses the
 * forensic stream — callers must also write a forensic line if they want
 * the event in the JSONL.
 */
export function capturePosthogException(error: unknown, context: Record<string, unknown> = {}): void {
  const c = getClient();
  if (!c) return;
  try {
    const props = {
      runtime: 'evolution-api',
      release: RELEASE,
      ...sanitizeContext(context),
    };
    const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
    c.captureException(err, undefined, props);
  } catch {
    /* noop */
  }
}

export function isPosthogRouterEnabled(): boolean {
  return Boolean(API_KEY);
}

/**
 * Subscribe to the forensic stream. Idempotent — calling twice is a no-op.
 * Loaded as a side effect from main.ts so the subscription is active before
 * the first instance boots.
 */
export function initPosthogRouter(): void {
  if (!API_KEY) {
    // eslint-disable-next-line no-console
    console.log('[posthog-router] POSTHOG_API_KEY not set — disabled');
    return;
  }
  if (unsubscribe) return;
  // Force client construction so subsequent forensic events route immediately.
  getClient();
  unsubscribe = subscribeForensic(routeForensicToPosthog);
  // eslint-disable-next-line no-console
  console.log(`[posthog-router] subscribed (release=${RELEASE})`);
}

export async function shutdownPosthogRouter(timeoutMs = 2000): Promise<void> {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (!client) return;
  try {
    await client.shutdown(timeoutMs);
  } catch {
    /* noop */
  }
}

// Exposed for tests only.
export const __TEST__ = {
  shouldForward,
  buildError,
  resetRateLimit: () => lastForwarded.clear(),
  FORWARD_KINDS,
  RATE_LIMITED_KINDS,
};

// Side-effect: initialize on import. main.ts loads this module via its
// ordered side-effect import list (after global-fetch-instrument and
// instrumentSentry, before bootstrap()).
initPosthogRouter();
