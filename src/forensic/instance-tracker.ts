import { forensic, writeSnapshot } from './forensic-logger';

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
const ZOMBIE_GAP_MS = Number(process.env.FORENSIC_ZOMBIE_GAP_MS) || 10 * 60_000;

class InstanceTracker {
  private map = new Map<string, InstanceState>();
  private timer: NodeJS.Timeout | null = null;
  private lastEventLoopLagMs = 0;

  register(name: string, channel: 'baileys' | 'cloud', wsReadyState?: () => number | null) {
    const existing = this.map.get(name);
    if (existing) {
      existing.channel = channel;
      if (wsReadyState) existing.wsReadyState = wsReadyState;
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
    });
    forensic({ kind: 'instance.register', instance: name, channel }).catch(() => {});
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
      forensic({ kind: `event.${kind}`, instance: name, ...(detail ?? {}) }).catch(() => {});
    }
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
      }
    }
    forensic({ kind: 'baileys.handler.error', instance: name ?? null, ...detail }).catch(() => {});
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
          zombieSuspected,
          stalledPipeline,
        };
      }),
    };
  }

  startHeartbeat() {
    if (this.timer) return;
    this.measureEventLoopLag();
    this.timer = setInterval(() => {
      const snap = this.snapshot();
      writeSnapshot(snap).catch(() => {});
      forensic({ kind: 'heartbeat', summary: snap }).catch(() => {});
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
