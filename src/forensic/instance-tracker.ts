import { forensic, forensicSync, subscribeForensic, writeSnapshot } from './forensic-logger';

export type ActivityKind =
  | 'connection.update'
  | 'creds.update'
  | 'messages.upsert'
  | 'messages.update'
  | 'messaging-history.set'
  | 'message-receipt.update'
  | 'presence.update'
  | 'chats.upsert'
  | 'contacts.upsert'
  | 'ws.message'
  | 'ws.close'
  | 'ws.error'
  | 'ws.open'
  | 'cloud.event'
  | 'webhook.delivery';

interface InstanceState {
  name: string;
  channel: 'baileys' | 'cloud';
  startedAt: number;
  lastActivityAt: number | null;
  lastActivityKind: string | null;
  // G2: separate Baileys-event activity (messages/chats/contacts/creds)
  // from raw ws.message frames. The 2026-04-30 zombie kept ws.message
  // flowing while messages.upsert was frozen for 27min — same lastActivityAt
  // hid the silence. Track them apart.
  lastBaileysEventAt: number | null;
  lastBaileysEventKind: string | null;
  lastWsMessageAt: number | null;
  activityCounts: Record<string, number>;
  lastConnectionUpdateAt: number | null;
  lastConnectionUpdate: unknown;
  lastWsCloseAt: number | null;
  lastWsClose: unknown;
  lastWsErrorAt: number | null;
  lastWsError: unknown;
  lastWebhookDeliveryAt: number | null;
  lastWebhookDelivery: unknown;
  lastWebhookFailureAt: number | null;
  lastWebhookFailure: unknown;
  // G4: handler-level rejections, e.g. fire-and-forget chats/contacts/groups
  // handlers that throw async. Recording per-instance helps attribute
  // unhandledRejections that don't carry their own context.
  lastHandlerErrorAt: number | null;
  lastHandlerError: unknown;
  handlerErrorCount: number;
  dbStatus: string | null;
  // populated by getter functions registered from the service
  wsReadyState?: () => number | null;
  // 2026-05-01: optional close hook so the heartbeat can force a reconnect
  // when a stall persists past the auto-heal threshold. Registered by the
  // baileys service alongside `wsReadyState`.
  forceClose?: (reason: string) => void;
  // tracks when stalledPipeline first became true in the current run, so
  // we can wait until it's been stuck for `AUTO_HEAL_AFTER_MS` before
  // tripping the heal action — we never want to react to a 1-tick blip.
  stalledSinceMs: number | null;
  lastAutoHealAt: number | null;
  autoHealCount: number;
  // 2026-05-01 v3.1: sliding-window error counters surfaced in every snapshot
  // so we can spot "is this happening continuously?" without grepping JSONL.
  // Per-instance for handler/auth-state errors; process-wide signals (mutex,
  // prisma, fetch) are also broadcast to every instance so the snapshot
  // reflects pool-wide pressure regardless of attribution.
  mutexTimeouts: BucketCounter;
  prismaTimeouts: BucketCounter;
  fetchErrors: BucketCounter;
  authStateTimeouts: BucketCounter;
  // Last connection.update payload signature, to dedupe the steady-state
  // pulse that fires {connection: null} dozens of times per second and
  // floods the JSONL with empty event lines that hide real transitions.
  lastConnectionUpdateSig: string | null;
}

interface BucketCounter {
  // Append-only ring of timestamps within the last hour. Cheap O(n) prune
  // on read (n is small — bound by error rate × window).
  timestamps: number[];
  // Last error message seen, for one-line debugging without JSONL grep.
  lastError: { ts: number; message: string } | null;
}

interface RingEntry {
  ts: number;
  kind: string;
  instance?: string | null;
  detail?: unknown;
}

const BAILEYS_EVENT_KINDS = new Set<string>([
  'messages.upsert',
  'messages.update',
  'messaging-history.set',
  'message-receipt.update',
  'chats.upsert',
  'chats.update',
  'chats.delete',
  'contacts.upsert',
  'contacts.update',
  'creds.update',
  'connection.update',
  'presence.update',
  'groups.upsert',
  'groups.update',
  'group-participants.update',
]);

const HEARTBEAT_MS = Number(process.env.FORENSIC_HEARTBEAT_MS) || 60_000;
// Lowered 2026-05-01 from 600_000 (10min) → 180_000 (3min). The investigation
// caught a 9m59s stall the old threshold missed by 1s; 3min validated against
// 4 days of forensic JSONL with zero false positives on legitimate quiet
// groups. Aligned with AUTO_HEAL_AFTER_MS so the heal trips on the second
// heartbeat after detection.
const ZOMBIE_GAP_MS = Number(process.env.FORENSIC_ZOMBIE_GAP_MS) || 3 * 60_000;
// Sliding-window sizes for error-rate counters surfaced in every snapshot.
const ERROR_WINDOW_5M = 5 * 60_000;
const ERROR_WINDOW_1H = 60 * 60_000;
// In-memory ring of recent forensic events. Survives even if disk JSONL has
// rotated out — included in the uncaughtException dump for self-contained
// post-mortems. 200 entries ≈ 3min of a chatty bot's significant events.
const RING_SIZE = Number(process.env.FORENSIC_RING_SIZE) || 200;

// Auto-heal: when `stalledPipeline` has been true continuously for this
// long, call `forceClose` to make Baileys reconnect with a fresh socket
// (and a fresh `processingMutex`). Disabled by default; enable by setting
// FORENSIC_AUTO_HEAL=true. After firing, we cool down for at least the
// same window before firing again on the same instance.
const AUTO_HEAL_ENABLED = String(process.env.FORENSIC_AUTO_HEAL || '').toLowerCase() === 'true';
const AUTO_HEAL_AFTER_MS = Number(process.env.FORENSIC_AUTO_HEAL_AFTER_MS) || 3 * 60_000;
const AUTO_HEAL_COOLDOWN_MS = Number(process.env.FORENSIC_AUTO_HEAL_COOLDOWN_MS) || 5 * 60_000;

function emptyBucket(): BucketCounter {
  return { timestamps: [], lastError: null };
}

function bumpBucket(b: BucketCounter, message?: string): void {
  const now = Date.now();
  b.timestamps.push(now);
  // Prune anything older than 1h to keep memory bounded under a sustained
  // error storm (worst case: ~3600 entries/h at 1Hz; harmless).
  const cutoff = now - ERROR_WINDOW_1H;
  let i = 0;
  while (i < b.timestamps.length && b.timestamps[i] < cutoff) i++;
  if (i > 0) b.timestamps.splice(0, i);
  if (message) b.lastError = { ts: now, message: message.slice(0, 300) };
}

function bucketSummary(b: BucketCounter) {
  const now = Date.now();
  let c5 = 0;
  for (const t of b.timestamps) if (now - t <= ERROR_WINDOW_5M) c5++;
  return { last5m: c5, last1h: b.timestamps.length, lastError: b.lastError };
}

class InstanceTracker {
  private map = new Map<string, InstanceState>();
  private timer: NodeJS.Timeout | null = null;
  private lastEventLoopLagMs = 0;
  // In-memory event ring — see RING_SIZE comment above.
  private ring: RingEntry[] = [];

  private pushRing(entry: Omit<RingEntry, 'ts'>): void {
    this.ring.push({ ts: Date.now(), ...entry });
    if (this.ring.length > RING_SIZE) {
      this.ring.splice(0, this.ring.length - RING_SIZE);
    }
  }

  ringTail(n = 50): RingEntry[] {
    return this.ring.slice(-n);
  }

  register(
    name: string,
    channel: 'baileys' | 'cloud',
    wsReadyState?: () => number | null,
    forceClose?: (reason: string) => void,
  ) {
    const existing = this.map.get(name);
    if (existing) {
      existing.channel = channel;
      if (wsReadyState) existing.wsReadyState = wsReadyState;
      if (forceClose) existing.forceClose = forceClose;
      return;
    }
    this.map.set(name, {
      name,
      channel,
      startedAt: Date.now(),
      lastActivityAt: null,
      lastActivityKind: null,
      lastBaileysEventAt: null,
      lastBaileysEventKind: null,
      lastWsMessageAt: null,
      activityCounts: {},
      lastConnectionUpdateAt: null,
      lastConnectionUpdate: null,
      lastWsCloseAt: null,
      lastWsClose: null,
      lastWsErrorAt: null,
      lastWsError: null,
      lastWebhookDeliveryAt: null,
      lastWebhookDelivery: null,
      lastWebhookFailureAt: null,
      lastWebhookFailure: null,
      lastHandlerErrorAt: null,
      lastHandlerError: null,
      handlerErrorCount: 0,
      dbStatus: null,
      wsReadyState,
      forceClose,
      stalledSinceMs: null,
      lastAutoHealAt: null,
      autoHealCount: 0,
      mutexTimeouts: emptyBucket(),
      prismaTimeouts: emptyBucket(),
      fetchErrors: emptyBucket(),
      authStateTimeouts: emptyBucket(),
      lastConnectionUpdateSig: null,
    });
    forensic({ kind: 'instance.register', instance: name, channel }).catch(() => {});
    this.pushRing({ kind: 'instance.register', instance: name });
  }

  unregister(name: string) {
    if (!this.map.has(name)) return;
    this.map.delete(name);
    forensic({ kind: 'instance.unregister', instance: name }).catch(() => {});
  }

  recordActivity(name: string, kind: ActivityKind, detail?: Record<string, unknown>) {
    const s = this.map.get(name);
    if (!s) return;
    const now = Date.now();
    s.lastActivityAt = now;
    s.lastActivityKind = kind;
    s.activityCounts[kind] = (s.activityCounts[kind] || 0) + 1;

    if (kind === 'ws.message') {
      s.lastWsMessageAt = now;
    } else if (BAILEYS_EVENT_KINDS.has(kind)) {
      s.lastBaileysEventAt = now;
      s.lastBaileysEventKind = kind;
      // pipeline recovered — reset the stall clock so the next zombie
      // gets a clean window before auto-heal trips.
      if (s.stalledSinceMs !== null) s.stalledSinceMs = null;
    }

    if (kind === 'connection.update') {
      s.lastConnectionUpdateAt = now;
      s.lastConnectionUpdate = detail ?? null;
    } else if (kind === 'ws.close') {
      s.lastWsCloseAt = now;
      s.lastWsClose = detail ?? null;
    } else if (kind === 'ws.error') {
      s.lastWsErrorAt = now;
      s.lastWsError = detail ?? null;
    }

    // Always log close/error/connection.update to forensic file as full lines.
    // Routine activity is summarized in heartbeat to keep file size sane.
    if (kind === 'connection.update' || kind === 'ws.close' || kind === 'ws.error' || kind === 'ws.open') {
      // Dedupe connection.update floods: the steady-state pulse fires it
      // dozens of times per second with {connection: null} only — useless
      // line noise that hid the meaningful transitions in the 2026-05-01
      // forensic trail. Compare the meaningful subset and skip duplicates.
      let shouldLog = true;
      if (kind === 'connection.update' && detail) {
        const sig = JSON.stringify({
          connection: (detail as any).connection ?? null,
          statusCode: (detail as any).statusCode ?? null,
          errorMessage: (detail as any).errorMessage ?? null,
          hasQr: (detail as any).hasQr ?? false,
        });
        if (
          s.lastConnectionUpdateSig === sig &&
          sig === '{"connection":null,"statusCode":null,"errorMessage":null,"hasQr":false}'
        ) {
          shouldLog = false;
        }
        s.lastConnectionUpdateSig = sig;
      }
      if (shouldLog) {
        forensic({ kind: `event.${kind}`, instance: name, ...(detail ?? {}) }).catch(() => {});
        this.pushRing({ kind: `event.${kind}`, instance: name, detail });
      }
    }
  }

  // 2026-05-01 v3.1: external signal hooks. The Baileys make-mutex patch and
  // global-fetch-instrument fire these so the snapshot can show error rates
  // without depending on JSONL parsing.
  recordMutexTimeout(instance: string | null | undefined, message?: string) {
    if (instance) {
      const s = this.map.get(instance);
      if (s) bumpBucket(s.mutexTimeouts, message);
    } else {
      // Mutex timeouts from inside Baileys can't reliably attribute to an
      // instance — broadcast to all so process-wide pressure is visible.
      for (const s of this.map.values()) bumpBucket(s.mutexTimeouts, message);
    }
    this.pushRing({ kind: 'baileys.mutex.timeout', instance: instance ?? null });
  }

  recordPrismaTimeout(message: string, model?: string, op?: string) {
    // Prisma timeouts are pool-wide pressure: bump every instance bucket.
    for (const s of this.map.values()) bumpBucket(s.prismaTimeouts, `${model ?? '?'}.${op ?? '?'}: ${message}`);
    this.pushRing({ kind: 'prisma.timeout', detail: { model, op, message: message.slice(0, 200) } });
  }

  recordFetchError(host: string, message?: string) {
    // Fetch errors aren't naturally per-instance either; broadcast.
    for (const s of this.map.values()) bumpBucket(s.fetchErrors, `${host}: ${message ?? ''}`);
    this.pushRing({ kind: 'fetch.error', detail: { host, message } });
  }

  recordWebhookDelivery(
    name: string | null | undefined,
    detail: {
      url: string;
      event: string;
      origin?: string;
      ok: boolean;
      httpStatus?: number | null;
      latencyMs: number;
      attempt?: number;
      error?: { code?: string; message?: string; isTimeout?: boolean } | null;
    },
  ) {
    const now = Date.now();
    if (name) {
      const s = this.map.get(name);
      if (s) {
        if (detail.ok) {
          s.lastWebhookDeliveryAt = now;
          s.lastWebhookDelivery = detail;
        } else {
          s.lastWebhookFailureAt = now;
          s.lastWebhookFailure = detail;
        }
      }
    }
    forensic({ kind: 'webhook.delivery', instance: name ?? null, ...detail }).catch(() => {});
  }

  setDbStatus(name: string, status: string | null) {
    const s = this.map.get(name);
    if (s) s.dbStatus = status;
  }

  recordHandlerError(
    name: string | null | undefined,
    detail: { handler: string; error: { message?: string; name?: string; stack?: string } },
  ) {
    const now = Date.now();
    if (name) {
      const s = this.map.get(name);
      if (s) {
        s.lastHandlerErrorAt = now;
        s.lastHandlerError = detail;
        s.handlerErrorCount += 1;
        // Attribute auth-state timeouts to the per-instance bucket so the
        // snapshot can show "this instance is dragging on Prisma" vs
        // "process-wide Prisma is sick" at a glance.
        if (detail.handler.startsWith('authState.') || detail.handler === 'AuthStateTimeoutError') {
          bumpBucket(s.authStateTimeouts, detail.error?.message);
        }
      }
    }
    forensic({ kind: 'baileys.handler.error', instance: name ?? null, ...detail }).catch(() => {});
    this.pushRing({ kind: 'baileys.handler.error', instance: name ?? null, detail });
  }

  snapshot() {
    const now = Date.now();
    const mem = process.memoryUsage();
    return {
      ts: new Date(now).toISOString(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      eventLoopLagMs: this.lastEventLoopLagMs,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
      },
      instances: Array.from(this.map.values()).map((s) => {
        const wsRs = s.wsReadyState?.() ?? null;
        const msSinceActivity = s.lastActivityAt ? now - s.lastActivityAt : null;
        const msSinceBaileysEvent = s.lastBaileysEventAt ? now - s.lastBaileysEventAt : null;
        const msSinceWsMessage = s.lastWsMessageAt ? now - s.lastWsMessageAt : null;
        // G2: zombie criteria now keys off Baileys events, not raw ws frames.
        // ws.message keeps flowing during a stalled event pipeline; only the
        // gap on real Baileys events tells us the app logic is dead.
        const zombieSuspected =
          s.dbStatus === 'open' && msSinceBaileysEvent !== null && msSinceBaileysEvent > ZOMBIE_GAP_MS;
        // Strong signal: WS frames are arriving but Baileys events aren't
        // being emitted — the exact pattern from the 2026-04-30 incident.
        const stalledPipeline =
          s.dbStatus === 'open' &&
          msSinceWsMessage !== null &&
          msSinceWsMessage < 60_000 &&
          msSinceBaileysEvent !== null &&
          msSinceBaileysEvent > ZOMBIE_GAP_MS;
        return {
          name: s.name,
          channel: s.channel,
          dbStatus: s.dbStatus,
          wsReadyState: wsRs,
          uptimeSec: Math.round((now - s.startedAt) / 1000),
          lastActivityKind: s.lastActivityKind,
          lastBaileysEventKind: s.lastBaileysEventKind,
          msSinceLastActivity: msSinceActivity,
          msSinceLastBaileysEvent: msSinceBaileysEvent,
          msSinceLastWsMessage: msSinceWsMessage,
          msSinceLastConnectionUpdate: s.lastConnectionUpdateAt ? now - s.lastConnectionUpdateAt : null,
          msSinceLastWsClose: s.lastWsCloseAt ? now - s.lastWsCloseAt : null,
          msSinceLastWebhookDelivery: s.lastWebhookDeliveryAt ? now - s.lastWebhookDeliveryAt : null,
          msSinceLastWebhookFailure: s.lastWebhookFailureAt ? now - s.lastWebhookFailureAt : null,
          msSinceLastHandlerError: s.lastHandlerErrorAt ? now - s.lastHandlerErrorAt : null,
          handlerErrorCount: s.handlerErrorCount,
          activityCounts: s.activityCounts,
          lastConnectionUpdate: s.lastConnectionUpdate,
          lastWsClose: s.lastWsClose,
          lastWsError: s.lastWsError,
          lastWebhookDelivery: s.lastWebhookDelivery,
          lastWebhookFailure: s.lastWebhookFailure,
          lastHandlerError: s.lastHandlerError,
          // 2026-05-01 v3.1: per-snapshot rate counters — visible in every
          // /forensic/snapshot response, no JSONL parsing required to answer
          // "is something silently failing every 30s?"
          mutexTimeouts: bucketSummary(s.mutexTimeouts),
          prismaTimeouts: bucketSummary(s.prismaTimeouts),
          fetchErrors: bucketSummary(s.fetchErrors),
          authStateTimeouts: bucketSummary(s.authStateTimeouts),
          autoHealCount: s.autoHealCount,
          msSinceLastAutoHeal: s.lastAutoHealAt ? now - s.lastAutoHealAt : null,
          msSinceStalledStart: s.stalledSinceMs ? now - s.stalledSinceMs : null,
          zombieSuspected,
          stalledPipeline,
        };
      }),
      thresholds: {
        zombieGapMs: ZOMBIE_GAP_MS,
        autoHealEnabled: AUTO_HEAL_ENABLED,
        autoHealAfterMs: AUTO_HEAL_AFTER_MS,
        autoHealCooldownMs: AUTO_HEAL_COOLDOWN_MS,
        heartbeatMs: HEARTBEAT_MS,
      },
      ringSize: this.ring.length,
    };
  }

  // For error.config.ts: synchronously dump snapshot + ring tail into the
  // forensic JSONL when the process is about to die. Self-contained so a
  // post-mortem doesn't require disk JSONL retention.
  emergencyFlushSync(reason: string, extra?: Record<string, unknown>) {
    try {
      forensicSync({
        kind: `emergency.${reason}`,
        ...(extra ?? {}),
        snapshot: this.snapshot(),
        ringTail: this.ringTail(50),
      });
    } catch {
      /* noop */
    }
  }

  startHeartbeat() {
    if (this.timer) return;
    this.measureEventLoopLag();
    this.timer = setInterval(() => {
      const snap = this.snapshot();
      writeSnapshot(snap).catch(() => {});
      forensic({ kind: 'heartbeat', summary: snap }).catch(() => {});
      const now = Date.now();
      for (const inst of snap.instances) {
        if (inst.stalledPipeline) {
          forensic({
            kind: 'pipeline.stalled',
            instance: inst.name,
            ...inst,
          }).catch(() => {});
        } else if (inst.zombieSuspected) {
          forensic({
            kind: 'zombie.suspected',
            instance: inst.name,
            ...inst,
          }).catch(() => {});
        }

        // Track the start of a continuous stall + maybe auto-heal.
        const state = this.map.get(inst.name);
        if (!state) continue;
        const isStalled = inst.stalledPipeline || inst.zombieSuspected;
        if (isStalled && state.stalledSinceMs === null) {
          state.stalledSinceMs = now;
        }
        if (
          AUTO_HEAL_ENABLED &&
          isStalled &&
          state.stalledSinceMs !== null &&
          now - state.stalledSinceMs >= AUTO_HEAL_AFTER_MS &&
          (state.lastAutoHealAt === null || now - state.lastAutoHealAt >= AUTO_HEAL_COOLDOWN_MS) &&
          typeof state.forceClose === 'function'
        ) {
          const stalledForMs = now - state.stalledSinceMs;
          state.lastAutoHealAt = now;
          state.autoHealCount += 1;
          forensic({
            kind: 'autoheal.fire',
            instance: inst.name,
            stalledForMs,
            autoHealCount: state.autoHealCount,
            reason: inst.stalledPipeline ? 'stalled-pipeline' : 'zombie-suspected',
          }).catch(() => {});
          try {
            state.forceClose(`autoheal:${inst.stalledPipeline ? 'stalled' : 'zombie'}:${stalledForMs}ms`);
          } catch (err: any) {
            forensic({
              kind: 'autoheal.error',
              instance: inst.name,
              error: { message: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join('\n') },
            }).catch(() => {});
          }
        }
      }
    }, HEARTBEAT_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private measureEventLoopLag() {
    const sample = () => {
      const start = Date.now();
      setTimeout(() => {
        this.lastEventLoopLagMs = Date.now() - start - 500;
        sample();
      }, 500).unref?.();
    };
    sample();
  }
}

export const instanceTracker = new InstanceTracker();

// 2026-05-01 v3.1: route every forensic() event through the tracker so the
// snapshot counters stay current without a polling loop. We listen for the
// kinds we know about; everything else is ignored. Observers are synchronous
// and swallowed if they throw, so this is safe on the hot path.
subscribeForensic((event) => {
  switch (event.kind) {
    case 'prisma.timeout':
      instanceTracker.recordPrismaTimeout(
        String((event as any).message ?? ''),
        (event as any).model as string | undefined,
        (event as any).op as string | undefined,
      );
      break;
    case 'fetch.error':
    case 'fetch.slow':
      instanceTracker.recordFetchError(
        String((event as any).host ?? (event as any).url ?? '?'),
        String((event as any).message ?? (event as any).error?.message ?? ''),
      );
      break;
    case 'baileys.mutex.timeout':
      // Emitted both by the in-tree handler-error path and (synchronously,
      // outside this process tree) by the make-mutex.js patch via raw
      // fs.appendFileSync — the latter does NOT pass through forensic() so
      // it doesn't reach this observer. We still bump from the in-tree
      // path; the JSONL line written by the patch is the authoritative
      // source for cumulative counts.
      instanceTracker.recordMutexTimeout(
        ((event as any).instance ?? null) as string | null,
        String((event as any).message ?? ''),
      );
      break;
    case 'authstate.io.timeout': {
      // The auth-state v3 patch writes this on every Prisma/Redis/fs
      // timeout inside useMultiFileAuthStatePrisma. Carries `sessionId`
      // (which IS the instance name) and `op` ("prisma.session.findUnique"
      // etc.). Route to the per-instance authStateTimeouts bucket via
      // recordHandlerError so the existing handlerErrorCount also bumps.
      const inst = ((event as any).sessionId ?? (event as any).instance ?? null) as string | null;
      if (inst) {
        instanceTracker.recordHandlerError(inst, {
          handler: 'authState.' + ((event as any).op ?? 'io'),
          error: { message: `auth-state I/O timeout on ${(event as any).key ?? '?'}` },
        });
      }
      break;
    }
  }
});
