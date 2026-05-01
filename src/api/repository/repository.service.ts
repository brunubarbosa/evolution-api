import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { forensic } from '@forensic/forensic-logger';
import { endInFlight, inFlightStats, startInFlight } from '@forensic/in-flight';
import { PrismaClient } from '@prisma/client';

export class Query<T> {
  where?: T;
  sort?: 'asc' | 'desc';
  page?: number;
  offset?: number;
}

// Per-call timeout for *every* Prisma operation.
//
// Why: the 2026-05-01 incident showed nine Prisma connections wedged in
// Postgres `idle/ClientRead` state for 3.6 hours. They were chatbot-fan-
// out SELECTs (Typebot/Flowise/Dify/Webhook/Contact/Chat) issued from
// `messages.upsert` handlers. The auth-state v3 timeout did not help —
// these calls live outside `useMultiFileAuthStatePrisma`. With the default
// pool of 9 connections all wedged, every subsequent message handler
// blocks waiting for a free pool slot, and the bot zombies until restart.
//
// Approach: monkey-patch each model delegate's mutating/reading methods
// at construction time. We can't use Prisma's $use middleware (removed
// in Prisma 6) and we can't use $extends without breaking the typed
// surface that callers rely on. Patching the bound delegate methods
// keeps the public type of `prismaRepository.typebot.findFirst(...)`
// intact while still letting us race every call against a timeout and
// register it in the in-flight map.
//
// On timeout we:
//   1. emit a `prisma.timeout` forensic event with model+op+args.shape so
//      future investigations have a smoking gun without pg_stat_activity
//   2. reject the await — the next caller won't queue forever behind a
//      Promise that never settles. Postgres' own `idle_session_timeout`
//      (set on DATABASE_CONNECTION_URI) is the deeper fix that actually
//      reclaims the wedged backend.
const QUERY_TIMEOUT_MS = Number(process.env.PRISMA_QUERY_TIMEOUT_MS) || 30_000;
const SLOW_QUERY_LOG_MS = Number(process.env.PRISMA_SLOW_QUERY_LOG_MS) || 5_000;

class PrismaTimeoutError extends Error {
  constructor(
    public readonly model: string,
    public readonly op: string,
    public readonly timeoutMs: number,
  ) {
    super(`Prisma ${model}.${op} did not resolve within ${timeoutMs}ms`);
    this.name = 'PrismaTimeoutError';
  }
}

function shortStack(): string {
  const e = new Error();
  // strip the Error frame and the wrapper frames so the first useful
  // line is the actual caller.
  return (e.stack ?? '').split('\n').slice(4, 10).join('\n');
}

function previewArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v == null) {
      out[k] = v;
    } else if (typeof v === 'object') {
      out[k] = `[${Array.isArray(v) ? 'array' : 'object'}]`;
    } else if (typeof v === 'string') {
      out[k] = v.length > 64 ? v.slice(0, 64) + '…' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Wrap *reads only*. Mutations (create/update/upsert/delete) return
// PrismaPromise instances that are sometimes batched via
// `prisma.$transaction([promiseA, promiseB])` — converting them to plain
// Promises breaks transaction batching (the contact-upsert path in
// whatsapp.baileys.service.ts:1000 does exactly this).
//
// All nine queries wedged in the 2026-05-01 incident were reads or a
// solo upsert/update outside any $transaction — so this still catches
// the bulk of the failure surface without risking a transaction regression.
const PATCHED_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

function wrapDelegate(model: string, delegate: any): void {
  if (!delegate || typeof delegate !== 'object') return;
  for (const op of PATCHED_OPS) {
    const original = delegate[op];
    if (typeof original !== 'function') continue;
    if ((original as any).__evolutionWrapped) continue;
    const wrapped = function (this: any, args?: any) {
      const stack = shortStack();
      const inflightId = startInFlight({
        kind: 'prisma',
        model,
        op,
        hint: previewArgs(args) as string | undefined,
        stack,
      });
      const start = Date.now();

      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new PrismaTimeoutError(model, op, QUERY_TIMEOUT_MS));
        }, QUERY_TIMEOUT_MS);
        timer.unref?.();
      });

      // Prisma delegate methods return a "thenable" PrismaPromise. We
      // call it to start the query, then race it against the timer.
      const queryPromise = Promise.resolve(original.apply(this, [args]));

      return Promise.race([queryPromise, timeoutPromise])
        .then(
          (result) => {
            const elapsed = Date.now() - start;
            if (elapsed >= SLOW_QUERY_LOG_MS) {
              forensic({
                kind: 'prisma.slow',
                model,
                op,
                durationMs: elapsed,
                args: previewArgs(args),
              }).catch(() => {});
            }
            return result;
          },
          (err) => {
            if (err instanceof PrismaTimeoutError) {
              forensic({
                kind: 'prisma.timeout',
                model,
                op,
                timeoutMs: QUERY_TIMEOUT_MS,
                elapsed: Date.now() - start,
                args: previewArgs(args),
                inflight: inFlightStats(),
                stack,
              }).catch(() => {});
            }
            throw err;
          },
        )
        .finally(() => {
          if (timer) clearTimeout(timer);
          endInFlight(inflightId);
        });
    };
    (wrapped as any).__evolutionWrapped = true;
    delegate[op] = wrapped;
  }
}

export class PrismaRepository extends PrismaClient {
  constructor(private readonly configService: ConfigService) {
    super({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    (this as any).$on('warn', (e: any) => {
      forensic({ kind: 'prisma.warn', message: e?.message, target: e?.target }).catch(() => {});
    });
    (this as any).$on('error', (e: any) => {
      forensic({ kind: 'prisma.error', message: e?.message, target: e?.target }).catch(() => {});
    });

    // Patch every model delegate. We enumerate own + inherited keys; the
    // delegates are plain object properties on the PrismaClient instance.
    const seen = new Set<string>();
    for (const key of Object.keys(this as any)) {
      if (key.startsWith('_') || key.startsWith('$')) continue;
      const value = (this as any)[key];
      if (!value || typeof value !== 'object') continue;
      // delegates have findFirst / findMany etc. — sniff for them
      if (typeof (value as any).findFirst !== 'function' && typeof (value as any).findMany !== 'function') continue;
      seen.add(key);
      wrapDelegate(key, value);
    }
    this.logger.info(`Repository:Prisma - delegates wrapped (${seen.size}, timeoutMs=${QUERY_TIMEOUT_MS})`);
  }

  private readonly logger = new Logger('PrismaRepository');

  public async onModuleInit() {
    await this.$connect();
    this.logger.info('Repository:Prisma - ON');
  }

  public async onModuleDestroy() {
    await this.$disconnect();
    this.logger.warn('Repository:Prisma - OFF');
  }
}
