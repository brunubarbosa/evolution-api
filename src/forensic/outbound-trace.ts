/**
 * Temporary end-to-end outbound tracer (Evolution side).
 *
 * Companion of the worker-side tracer in
 *   apps/moderation-worker/src/evolution/client.ts
 *
 * Both ends write breadcrumbs to a single Redis Stream called
 * `outbound:trace` (XADD … MAXLEN ~ 50000). The worker emits L1.worker;
 * Evolution emits L2.http (HTTP arrival), L3.send (just before handing
 * the message to Baileys), and Baileys itself emits L4.relay just before
 * the WS frame leaves. Grouped by `trace_id` you get a 4-layer chain per
 * outbound message.
 *
 * Always on — no feature flag. The cache Redis client must be ENABLED
 * (`CACHE_REDIS_ENABLED=true` + `CACHE_REDIS_URI=...`); when it isn't,
 * breadcrumbs silently no-op — never break a send.
 *
 * This file is intentionally standalone — no dependency on the Logger
 * class, no app-level singletons — so it can be imported by both Express
 * routes (synchronous mount) and the deep baileys service (post-init) with
 * no ordering surprises.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import { redisClient } from '../cache/rediscache.client';

/**
 * Per-request trace context, populated by the Express middleware in
 * sendMessage.router and read by the Baileys service. Using
 * AsyncLocalStorage means we don't have to thread `traceId` through
 * every controller/service method — the value flows automatically
 * across async/await boundaries within the request's call tree.
 *
 * Reading: `outboundTraceContext.getStore()?.traceId`. Returns undefined
 * outside a tracer-wrapped request OR when the flag is off.
 */
export interface TraceStoreShape {
  traceId: string;
  /** 'header' = caller (likely the GDW worker) supplied the id.
   *  'minted' = nobody did, so we minted one and the caller is UNKNOWN. */
  origin: 'header' | 'minted';
}
export const outboundTraceContext = new AsyncLocalStorage<TraceStoreShape>();

const STREAM_KEY = 'outbound:trace';
const STREAM_MAXLEN = '50000';

export function mintTraceId(): string {
  return randomUUID();
}

export type TraceLayer = 'L2.http' | 'L3.send' | 'L4.relay';

/**
 * Fire-and-forget — caller MUST NOT await unless they want the trace
 * write to gate the actual send. We swallow every error: the tracer
 * exists to help debug; it must never be a blast radius.
 */
export function emitTraceFireAndForget(
  traceId: string,
  layer: TraceLayer,
  fields: Record<string, string | number | boolean | undefined | null>,
): void {
  // Lazy-grab; the cache singleton handles connect on first use.
  const client = (() => {
    try {
      return redisClient.getConnection();
    } catch {
      return null;
    }
  })();
  if (!client) return;

  // Flatten the fields object → XADD's pair-list, dropping undefined/null
  // so the stream stays small and JSON-grep-friendly.
  const args: string[] = [];
  args.push('trace_id', traceId, 'layer', layer);
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    args.push(k, typeof v === 'string' ? v : String(v));
  }

  // node-redis v4 returns a Promise; we don't await it. Errors land in
  // .catch (silent) — broken Redis must not break a send.
  Promise.resolve()
    .then(() =>
      client.xAdd(
        STREAM_KEY,
        '*',
        // node-redis v4 typings: a Record<string, string> message body.
        // We pre-flattened, so recompose:
        pairsToRecord(args),
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: Number(STREAM_MAXLEN) } },
      ),
    )
    .catch(() => {
      /* tracer must never throw */
    });
}

function pairsToRecord(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < pairs.length; i += 2) {
    const k = pairs[i];
    const v = pairs[i + 1];
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Convenience: hash a payload into a short, comparable digest. Used so
 * we can group "same body, different layer" without storing the full
 * text — keeps stream entries compact.
 */
/**
 * Bridge: register a globalThis hook that the patched Baileys
 * relayMessage calls with its L4.relay payload. Baileys has no Redis
 * dependency; this hook XADDs the payload into the same `outbound:trace`
 * stream as the other layers so the tail CLI sees a single unified
 * timeline.
 *
 * Idempotent — re-importing this module won't double-register.
 */
function registerBaileysHook() {
  if ((globalThis as any).__gdwOutboundTraceHook__) return;
  (globalThis as any).__gdwOutboundTraceHook__ = (payload: Record<string, unknown>) => {
    const traceId = String(payload?.trace_id ?? '');
    if (!traceId) return;
    const fields: Record<string, string | number | boolean | undefined | null> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'trace_id' || k === 'layer') continue;
      if (v === undefined || v === null) continue;
      fields[k] = v as string | number | boolean;
    }
    emitTraceFireAndForget(traceId, 'L4.relay', fields);
  };
}
registerBaileysHook();

export function shortHash(s: string | undefined | null): string {
  if (!s) return '';
  // tiny FNV-1a — good enough for trace correlation.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
