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
  dbStatus: string | null;
  // populated by getter functions registered from the service
  wsReadyState?: () => number | null;
  // ms since last successful keep-alive — Baileys-side; we infer from activity gap
}

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
        const zombieSuspected =
          s.dbStatus === 'open' &&
          msSinceActivity !== null &&
          msSinceActivity > ZOMBIE_GAP_MS &&
          (wsRs === null || wsRs !== 1);
        return {
          name: s.name,
          channel: s.channel,
          dbStatus: s.dbStatus,
          wsReadyState: wsRs,
          uptimeSec: Math.round((now - s.startedAt) / 1000),
          lastActivityKind: s.lastActivityKind,
          msSinceLastActivity: msSinceActivity,
          msSinceLastConnectionUpdate: s.lastConnectionUpdateAt ? now - s.lastConnectionUpdateAt : null,
          msSinceLastWsClose: s.lastWsCloseAt ? now - s.lastWsCloseAt : null,
          msSinceLastWebhookDelivery: s.lastWebhookDeliveryAt ? now - s.lastWebhookDeliveryAt : null,
          msSinceLastWebhookFailure: s.lastWebhookFailureAt ? now - s.lastWebhookFailureAt : null,
          activityCounts: s.activityCounts,
          lastConnectionUpdate: s.lastConnectionUpdate,
          lastWsClose: s.lastWsClose,
          lastWsError: s.lastWsError,
          lastWebhookDelivery: s.lastWebhookDelivery,
          lastWebhookFailure: s.lastWebhookFailure,
          zombieSuspected,
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
        if (inst.zombieSuspected) {
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
