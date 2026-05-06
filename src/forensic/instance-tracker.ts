import { forensic, forensicSync, subscribeForensic, writeSnapshot } from './forensic-logger';
import { inFlightSnapshot } from './in-flight';

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
  // 2026-05-04: streak of autoheal fires since the last successful reconnect.
  // Resets on `reconnect.success`. Used to detect "we're firing forever and
  // recovering nothing" — when this passes AUTO_HEAL_GIVEUP_AFTER we emit
  // `autoheal.giveup` once so monitoring can surface "auth state likely toast,
  // operator re-pair needed."
  autoHealStreak: number;
  autoHealGiveupEmitted: boolean;
  // 2026-05-06 v5: hard-stop the autoheal loop after this many consecutive
  // zombie-rebirths (NOT just autoheal fires — those are normal during a
  // legitimate stall). A rebirth means we constructed a fresh socket and
  // WhatsApp silently rejected it — the auth-invalidation pattern from the
  // 5h zombie. Once permanently stopped, no further autoheal.fire events
  // emit until either:
  //   - recordReconnectSuccess() runs (operator re-paired, real open arrived)
  //   - the process restarts
  // Surfaces the "operator must re-pair" state without ambiguity.
  consecutiveRebirthCount: number;
  autoHealPermanentlyStopped: boolean;
  autoHealPermanentStopAt: number | null;
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
  // 2026-05-04: reconnect lifecycle. Tracked so the snapshot can answer
  // "is this instance flapping?" without parsing JSONL. Each entry records
  // a single decided reconnect (or terminal). `recentReconnects` is a sliding
  // ring of timestamps used by the flapping guard.
  reconnectAttempts: number;
  lastReconnectAt: number | null;
  reconnectHistory: ReconnectHistoryEntry[];
  recentReconnectTimestamps: number[];

  // 2026-05-06 v4: client generation counter. Increments every time
  // BaileysStartupService.createClient() runs (initial boot + every reinit).
  // Surfaces in snapshots so cross-referencing "what happened to client #5
  // before client #6 was born" is possible from JSONL alone. Without this,
  // the 5h zombie incident was hard to interpret because 27 reinits looked
  // identical from the outside.
  clientGen: number;
  // Wall-clock at the last createClient() call.
  clientGenStartedAt: number | null;
  // Whether we observed a connection.update {open} on the current generation.
  // Reset by incrementClientGen, set true by recordReconnectSuccess /
  // recordActivity('connection.update', {connection:'open'}).
  currentGenOpened: boolean;
  // Per-generation count of connection.update {open} events. The 5h zombie
  // had 27 reinits, 31 ws.opens, but currentGenOpenedCount stayed at 1
  // (last good gen). This counter makes that pathology obvious.
  currentGenOpenedAt: number | null;

  // Live Baileys event-emitter listener counts, populated by an optional
  // getter the service registers alongside wsReadyState. Captures the
  // listener-leak signature directly: if these grow monotonically with
  // clientGen, old client.ev listeners aren't being detached on reinit.
  evListenerCount?: () => Record<string, number> | null;
  wsListenerCount?: () => Record<string, number> | null;

  // 2026-05-06 v4: post-reinit zombie-rebirth signal. Set when an autoheal
  // reinit completes but the new socket fails to emit connection.update {open}
  // within the probe window. Surfaces "the heal succeeded but the socket
  // is born dead" — the exact pattern of the 5h zombie.
  lastReinitZombieRebirthAt: number | null;
  reinitZombieRebirthCount: number;

  // Last fetch.error/fetch.terminated event captured per-instance — wired
  // through global-fetch-instrument when the URL was identifiable. Helps
  // attribute undici "terminated" cascades to the specific media or
  // webhook URL that triggered them.
  lastFetchError: { ts: number; url: string; host: string; message: string } | null;
}

export interface ReconnectHistoryEntry {
  ts: number;
  decision: 'reconnect' | 'terminal' | 'flapping-stopped';
  reason: string;
  statusCode: number | null;
  attempt: number;
  delayMs: number | null;
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
// 📘 Threshold rationale + incident history: reconnect-runbook.md
// (in grupodewhatsapp/docs/evolution-fork/). Don't tune any of these without
// reading the "why these specific numbers" table.
const AUTO_HEAL_ENABLED = String(process.env.FORENSIC_AUTO_HEAL || '').toLowerCase() === 'true';
const AUTO_HEAL_AFTER_MS = Number(process.env.FORENSIC_AUTO_HEAL_AFTER_MS) || 3 * 60_000;
const AUTO_HEAL_COOLDOWN_MS = Number(process.env.FORENSIC_AUTO_HEAL_COOLDOWN_MS) || 5 * 60_000;
// 2026-05-04: after this many consecutive autoheal fires with no successful
// reconnect (zombie streak unbroken), emit `autoheal.giveup` once. The
// runbook calls this case out as "auth state likely unrecoverable — operator
// must re-pair." We don't *stop* trying (the reinit might still succeed) but
// we surface the signal loud so monitoring can catch it.
const AUTO_HEAL_GIVEUP_AFTER = Number(process.env.FORENSIC_AUTO_HEAL_GIVEUP_AFTER) || 6;
// 2026-05-06 v5: stop the autoheal loop entirely after this many consecutive
// post-reinit zombie-rebirths. A rebirth = fresh socket constructed but no
// connection.update {open} arrived — the WhatsApp-side auth-rejection
// signature. Continuing to autoheal under this condition only antagonizes
// WA's anti-abuse defense further. Default 3 = "first rebirth could be
// transient, second is suspicious, third = stop and require operator action".
// Tighter than AUTO_HEAL_GIVEUP_AFTER (which counts fires, including normal
// fires during a real stall recovery).
const AUTO_HEAL_REBIRTH_STOP_AFTER = Number(process.env.FORENSIC_AUTO_HEAL_REBIRTH_STOP_AFTER) || 3;

// Reconnect fastpath: when ws.close fires but no connection.update {close}
// follows within this window, the Baileys handler short-circuited (e.g. an
// uncaughtException in undici took out the recovery path). The fastpath then
// invokes forceClose() so the auto-heal route runs in seconds rather than
// waiting the full ZOMBIE_GAP_MS / AUTO_HEAL_AFTER_MS for the heartbeat to
// notice. Default tuned for "is the handler going to get there or not?" —
// a healthy reconnect emits connection.update within 1-2s of ws.close.
const RECONNECT_FASTPATH_ENABLED = String(process.env.FORENSIC_RECONNECT_FASTPATH ?? 'true').toLowerCase() === 'true';
const RECONNECT_FASTPATH_AFTER_MS = Number(process.env.FORENSIC_RECONNECT_FASTPATH_AFTER_MS) || 5_000;

// Flapping guard: above this many reconnects in the window, stop and surface
// to the operator. The numbers here are intentionally conservative — a healthy
// instance reconnects 1-3× per hour at most, so 10 in 5min is unambiguous flap.
const FLAPPING_THRESHOLD = Number(process.env.FORENSIC_RECONNECT_FLAPPING_THRESHOLD) || 10;
const FLAPPING_WINDOW_MS = Number(process.env.FORENSIC_RECONNECT_FLAPPING_WINDOW_MS) || 5 * 60_000;

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
    listenerCounts?: {
      ev?: () => Record<string, number> | null;
      ws?: () => Record<string, number> | null;
    },
  ) {
    const existing = this.map.get(name);
    if (existing) {
      existing.channel = channel;
      if (wsReadyState) existing.wsReadyState = wsReadyState;
      if (forceClose) existing.forceClose = forceClose;
      if (listenerCounts?.ev) existing.evListenerCount = listenerCounts.ev;
      if (listenerCounts?.ws) existing.wsListenerCount = listenerCounts.ws;
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
      evListenerCount: listenerCounts?.ev,
      wsListenerCount: listenerCounts?.ws,
      stalledSinceMs: null,
      lastAutoHealAt: null,
      autoHealCount: 0,
      autoHealStreak: 0,
      autoHealGiveupEmitted: false,
      consecutiveRebirthCount: 0,
      autoHealPermanentlyStopped: false,
      autoHealPermanentStopAt: null,
      mutexTimeouts: emptyBucket(),
      prismaTimeouts: emptyBucket(),
      fetchErrors: emptyBucket(),
      authStateTimeouts: emptyBucket(),
      lastConnectionUpdateSig: null,
      reconnectAttempts: 0,
      lastReconnectAt: null,
      reconnectHistory: [],
      recentReconnectTimestamps: [],
      clientGen: 0,
      clientGenStartedAt: null,
      currentGenOpened: false,
      currentGenOpenedAt: null,
      lastReinitZombieRebirthAt: null,
      reinitZombieRebirthCount: 0,
      lastFetchError: null,
    });
    forensic({ kind: 'instance.register', instance: name, channel }).catch(() => {});
    this.pushRing({ kind: 'instance.register', instance: name });
  }

  // 2026-05-06 v4: increments clientGen and resets per-generation flags.
  // Called by BaileysStartupService.createClient() right after makeWASocket().
  // Returns the new generation number so the caller can stamp it on
  // forensic events (e.g. autoheal.reinit.success { clientGen: N }).
  //
  // First-call ordering: the service calls this BEFORE the full `register()`
  // call below (because the new gen needs to be stamped on the listener
  // closures that `register` captures). On the very first invocation the
  // instance map is empty, so we lazily create a minimal entry here. The
  // subsequent register() call will just update getter slots.
  incrementClientGen(
    name: string,
    source: 'boot' | 'reinit',
    extra?: {
      // 2026-05-06 v4.1: snapshot the OLD client's listener counts before
      // the service tears it down. The register-time getters always read
      // `this.client` on the service which by this point points at the
      // *new* client, so we can't introspect the dead one anymore. The
      // service captures these counts pre-cleanup and passes them in.
      previousGenWsListenerCount?: Record<string, number> | null;
      previousGenEvListenerCount?: Record<string, number> | null;
      // Heap snapshot at gen-advance time. Diff against the previous
      // gen's snapshot to detect listener-leak-induced memory growth.
      heapUsedMb?: number;
    },
  ): number {
    let s = this.map.get(name);
    if (!s) {
      this.register(name, 'baileys');
      s = this.map.get(name);
      if (!s) return 0;
    }
    const previous = s.clientGen;
    s.clientGen = previous + 1;
    s.clientGenStartedAt = Date.now();
    s.currentGenOpened = false;
    s.currentGenOpenedAt = null;
    forensic({
      kind: 'client.gen.advance',
      instance: name,
      previousGen: previous,
      newGen: s.clientGen,
      source,
      previousGenLastBaileysEventKind: s.lastBaileysEventKind,
      previousGenMsSinceLastBaileysEvent: s.lastBaileysEventAt ? Date.now() - s.lastBaileysEventAt : null,
      previousGenWsListenerCount: extra?.previousGenWsListenerCount ?? null,
      previousGenEvListenerCount: extra?.previousGenEvListenerCount ?? null,
      heapUsedMbAtAdvance: extra?.heapUsedMb ?? null,
    }).catch(() => {});
    return s.clientGen;
  }

  // Returns the current clientGen for tagging forensic events emitted from
  // the service. Returns 0 if the instance is unknown (won't crash callers).
  currentClientGen(name: string): number {
    return this.map.get(name)?.clientGen ?? 0;
  }

  // 2026-05-06 v4.2: invoke the registered forceClose hook for stress
  // testing. Wired through a debug endpoint (env-gated) so the listener-leak
  // test harness can deterministically trigger N consecutive reinits and
  // observe whether wsListenerCount/evListenerCount stay flat. Returns
  // false if there's no hook (cloud channel, or instance not yet booted).
  triggerForceCloseFromDebug(name: string, reason: string): boolean {
    const s = this.map.get(name);
    if (!s || typeof s.forceClose !== 'function') return false;
    try {
      s.forceClose(`debug:${reason}`);
      return true;
    } catch (err: any) {
      forensic({
        kind: 'debug.forceclose.error',
        instance: name,
        reason,
        error: { message: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join('\n') },
      }).catch(() => {});
      return false;
    }
  }

  // 2026-05-06 v4: post-reinit zombie-rebirth probe. Called by the autoheal
  // path after reinit.success — schedules a check at probeMs to verify the
  // new generation actually saw a connection.update {open}. If not, emits
  // `autoheal.reinit.zombie-rebirth` and bumps the per-instance counter so
  // the snapshot shows "this instance is heal-reinit-but-stillborn N times".
  scheduleReinitProbe(name: string, probeMs: number): void {
    const s = this.map.get(name);
    if (!s) return;
    const targetGen = s.clientGen;
    const startedAt = s.clientGenStartedAt ?? Date.now();
    setTimeout(() => {
      const ref = this.map.get(name);
      if (!ref) return;
      // If a newer reinit fired in the meantime, this probe is stale —
      // the next probe will cover the newer gen.
      if (ref.clientGen !== targetGen) return;
      if (ref.currentGenOpened) return; // Healthy: connection.update {open} arrived.
      ref.lastReinitZombieRebirthAt = Date.now();
      ref.reinitZombieRebirthCount += 1;
      // 2026-05-06 v5: track CONSECUTIVE rebirths. Resets on any healthy
      // open (handled in recordActivity / recordReconnectSuccess). When
      // this hits AUTO_HEAL_REBIRTH_STOP_AFTER, the autoheal loop stops
      // permanently — continuing only antagonizes WhatsApp's anti-abuse.
      ref.consecutiveRebirthCount += 1;
      const willPermanentlyStop =
        !ref.autoHealPermanentlyStopped && ref.consecutiveRebirthCount >= AUTO_HEAL_REBIRTH_STOP_AFTER;
      forensic({
        kind: 'autoheal.reinit.zombie-rebirth',
        instance: name,
        clientGen: targetGen,
        msSinceReinit: Date.now() - startedAt,
        msSinceLastBaileysEvent: ref.lastBaileysEventAt ? Date.now() - ref.lastBaileysEventAt : null,
        msSinceLastConnectionUpdate: ref.lastConnectionUpdateAt ? Date.now() - ref.lastConnectionUpdateAt : null,
        msSinceLastWsMessage: ref.lastWsMessageAt ? Date.now() - ref.lastWsMessageAt : null,
        lastConnectionUpdate: ref.lastConnectionUpdate,
        lastWsError: ref.lastWsError,
        wsReadyState: ref.wsReadyState?.() ?? null,
        evListenerCount: this.safeReadCounts(ref.evListenerCount),
        wsListenerCount: this.safeReadCounts(ref.wsListenerCount),
        rebirthCount: ref.reinitZombieRebirthCount,
        consecutiveRebirthCount: ref.consecutiveRebirthCount,
        willPermanentlyStopAutoHeal: willPermanentlyStop,
        hint: 'new socket constructed but no connection.update{open} arrived; auth-state replay or noise-handshake silent rejection likely. Process restart probably required.',
      }).catch(() => {});
      if (willPermanentlyStop) {
        ref.autoHealPermanentlyStopped = true;
        ref.autoHealPermanentStopAt = Date.now();
        forensic({
          kind: 'autoheal.permanent-stop',
          instance: name,
          consecutiveRebirthCount: ref.consecutiveRebirthCount,
          threshold: AUTO_HEAL_REBIRTH_STOP_AFTER,
          autoHealCount: ref.autoHealCount,
          hint: 'auto-heal loop disabled — operator must re-pair (logout + QR scan) to restore service. Further reinits would only worsen the WhatsApp anti-abuse flag.',
        }).catch(() => {});
      }
    }, probeMs).unref?.();
  }

  // Helper that calls a getter and shrugs if it throws (defensive — getters
  // touch live socket internals and may race with teardown).
  private safeReadCounts(getter?: () => Record<string, number> | null): Record<string, number> | null {
    if (!getter) return null;
    try {
      return getter() ?? null;
    } catch {
      return null;
    }
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
      // 2026-05-06 v4: mark the current client generation as "opened" the
      // first time we see {connection: 'open'}. The reinit probe checks
      // this flag — if still false at probe time, we caught a zombie rebirth.
      if (detail && (detail as any).connection === 'open' && !s.currentGenOpened) {
        s.currentGenOpened = true;
        s.currentGenOpenedAt = now;
        // 2026-05-06 v5: a healthy open clears the rebirth streak and (if
        // an operator re-paired) lifts the permanent-stop. The next zombie
        // pattern starts counting fresh.
        if (s.consecutiveRebirthCount > 0 || s.autoHealPermanentlyStopped) {
          const wasPermStopped = s.autoHealPermanentlyStopped;
          s.consecutiveRebirthCount = 0;
          s.autoHealPermanentlyStopped = false;
          s.autoHealPermanentStopAt = null;
          if (wasPermStopped) {
            forensic({
              kind: 'autoheal.permanent-stop.cleared',
              instance: name,
              hint: 'connection.update {open} arrived; autoheal re-armed. Likely operator re-paired.',
            }).catch(() => {});
          }
        }
      }
    } else if (kind === 'ws.close') {
      s.lastWsCloseAt = now;
      s.lastWsClose = detail ?? null;
      // Fastpath (layer 2 of 3 — see reconnect-runbook.md): schedule a check
      // for "did the connection.update handler ever run?". If not, the Baileys
      // reconnect path short-circuited (typically because undici threw a
      // TypeError: terminated mid-flight) and we must poke forceClose
      // ourselves. Logged either way so we can audit the gap.
      if (RECONNECT_FASTPATH_ENABLED) {
        const wsCloseTs = now;
        const instName = name;
        setTimeout(() => {
          const ref = this.map.get(instName);
          if (!ref) return;
          // If a connection.update arrived after the ws.close, the normal
          // handler is on the case — leave it alone.
          if (ref.lastConnectionUpdateAt && ref.lastConnectionUpdateAt > wsCloseTs) return;
          // dbStatus is set to 'close' by the service when the connection
          // moves to terminal (e.g. logout/conflict path); in that case
          // the operator has been notified and we don't auto-reconnect.
          if (ref.dbStatus === 'close') return;
          forensic({
            kind: 'reconnect.fastpath',
            instance: instName,
            reason: 'ws-close-without-connection-update',
            wsCloseAgeMs: Date.now() - wsCloseTs,
          }).catch(() => {});
          if (typeof ref.forceClose === 'function') {
            try {
              ref.forceClose('fastpath:ws-close-orphan');
            } catch (err: any) {
              forensic({
                kind: 'reconnect.fastpath.error',
                instance: instName,
                error: err?.message,
              }).catch(() => {});
            }
          }
        }, RECONNECT_FASTPATH_AFTER_MS).unref?.();
      }
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

  recordFetchError(host: string, message?: string, url?: string) {
    // Fetch errors aren't naturally per-instance either; broadcast to all
    // bucket counters. But also stash the URL on every instance's
    // lastFetchError slot so the heartbeat snapshot shows WHICH URL broke,
    // not just "you got fetch errors". Crucial for undici "terminated"
    // cascades that point at Node internals only.
    const now = Date.now();
    const stash = url ? { ts: now, url, host, message: (message ?? '').slice(0, 300) } : null;
    for (const s of this.map.values()) {
      bumpBucket(s.fetchErrors, `${host}: ${message ?? ''}`);
      if (stash) s.lastFetchError = stash;
    }
    this.pushRing({ kind: 'fetch.error', detail: { host, url, message } });
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

  // 2026-05-04: reconnect lifecycle hooks. The Baileys service calls these
  // around its connection.update {close} branch so the snapshot can answer
  // "is this instance reconnecting cleanly, or flapping?" at a glance —
  // and so we can stop auto-reconnecting if it gets stuck in a loop.
  //
  // 📘 FULL CONTEXT: grupodewhatsapp/docs/evolution-fork/reconnect-runbook.md
  // — explains the three layers (classifier / fastpath / auto-heal), the
  // disconnect-code distribution we tuned against, and how to triage incidents.
  //
  // The tracker owns the attempt counter (and the backoff math), because the
  // counter has to survive across instance recreations triggered by reconnect
  // itself. Caller passes the per-error baseDelayMs and we return the final
  // delayMs (with exponential backoff applied) plus whether to proceed.
  recordReconnectDecision(
    name: string,
    decision: 'reconnect' | 'terminal',
    detail: { reason: string; statusCode: number | null; baseDelayMs?: number },
  ): { allowed: boolean; attempt: number; delayMs: number | null; flapping: boolean } {
    const s = this.map.get(name);
    const now = Date.now();
    if (!s) {
      return { allowed: decision === 'reconnect', attempt: 0, delayMs: null, flapping: false };
    }

    if (decision === 'terminal') {
      s.reconnectHistory.push({
        ts: now,
        decision: 'terminal',
        reason: detail.reason,
        statusCode: detail.statusCode,
        attempt: s.reconnectAttempts,
        delayMs: null,
      });
      this.trimHistory(s);
      forensic({
        kind: 'reconnect.decision',
        instance: name,
        decision: 'terminal',
        reason: detail.reason,
        statusCode: detail.statusCode,
      }).catch(() => {});
      return { allowed: false, attempt: s.reconnectAttempts, delayMs: null, flapping: false };
    }

    // Prune timestamps older than the window before counting.
    const windowStart = now - FLAPPING_WINDOW_MS;
    s.recentReconnectTimestamps = s.recentReconnectTimestamps.filter((t) => t >= windowStart);
    const flapping = s.recentReconnectTimestamps.length >= FLAPPING_THRESHOLD;

    if (flapping) {
      s.reconnectHistory.push({
        ts: now,
        decision: 'flapping-stopped',
        reason: detail.reason,
        statusCode: detail.statusCode,
        attempt: s.reconnectAttempts,
        delayMs: null,
      });
      this.trimHistory(s);
      forensic({
        kind: 'reconnect.flapping',
        instance: name,
        recentCount: s.recentReconnectTimestamps.length,
        windowMs: FLAPPING_WINDOW_MS,
        threshold: FLAPPING_THRESHOLD,
        reason: detail.reason,
        statusCode: detail.statusCode,
      }).catch(() => {});
      return { allowed: false, attempt: s.reconnectAttempts, delayMs: null, flapping: true };
    }

    s.reconnectAttempts += 1;
    s.lastReconnectAt = now;
    s.recentReconnectTimestamps.push(now);
    // Exponential backoff over baseDelayMs, capped at 30s. The cap matters
    // because the auto-heal layer kicks in around 180s — we should not push
    // a single delay anywhere near that, otherwise we race auto-heal.
    const base = detail.baseDelayMs ?? 0;
    const delayMs = base === 0 ? 0 : Math.min(base * Math.pow(2, Math.max(0, s.reconnectAttempts - 1)), 30_000);
    s.reconnectHistory.push({
      ts: now,
      decision: 'reconnect',
      reason: detail.reason,
      statusCode: detail.statusCode,
      attempt: s.reconnectAttempts,
      delayMs,
    });
    this.trimHistory(s);
    forensic({
      kind: 'reconnect.decision',
      instance: name,
      decision: 'reconnect',
      reason: detail.reason,
      statusCode: detail.statusCode,
      attempt: s.reconnectAttempts,
      delayMs,
    }).catch(() => {});
    return { allowed: true, attempt: s.reconnectAttempts, delayMs, flapping: false };
  }

  // Called when connection.update fires {connection: 'open'} after a reconnect
  // attempt — clears the attempt counter so the next disconnect starts fresh
  // backoff. Without this, every reconnect compounds the previous backoff.
  recordReconnectSuccess(name: string): void {
    const s = this.map.get(name);
    if (!s) return;
    // Reset autoheal streak whenever we observe a real reconnect, even if
    // L1 didn't increment reconnectAttempts (e.g. autoheal-driven reinit).
    const hadStreak = s.autoHealStreak > 0;
    s.autoHealStreak = 0;
    s.autoHealGiveupEmitted = false;
    s.stalledSinceMs = null;
    if (s.reconnectAttempts === 0 && !hadStreak) return;
    forensic({
      kind: 'reconnect.success',
      instance: name,
      attempts: s.reconnectAttempts,
      autoHealStreakBeforeReset: hadStreak ? undefined : 0,
      msSinceFirstAttempt: s.reconnectHistory.length ? Date.now() - s.reconnectHistory[0].ts : null,
    }).catch(() => {});
    s.reconnectAttempts = 0;
  }

  recordReconnectFailed(name: string, attempt: number, error?: string): void {
    forensic({
      kind: 'reconnect.failed',
      instance: name,
      attempt,
      error: error?.slice(0, 300) ?? null,
    }).catch(() => {});
  }

  // Bound so a long-lived instance's history doesn't grow unbounded. We keep
  // the most recent 50 transitions which is plenty to spot a flap pattern.
  private trimHistory(s: InstanceState): void {
    if (s.reconnectHistory.length > 50) {
      s.reconnectHistory.splice(0, s.reconnectHistory.length - 50);
    }
  }

  snapshot() {
    const now = Date.now();
    const mem = process.memoryUsage();
    // 2026-05-06 v4: include in-flight summary in every snapshot. Pre-v4 this
    // ran only on uncaughtException (via dumpInFlight in error.config.ts), so
    // 9 leaked mutex tasks during the 5h zombie were invisible until we
    // grepped for `baileys.mutex.timeout` lines.
    const inflight = (() => {
      try {
        return inFlightSnapshot(10);
      } catch {
        return null;
      }
    })();
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
      inflight,
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
          autoHealStreak: s.autoHealStreak,
          autoHealGiveupEmitted: s.autoHealGiveupEmitted,
          msSinceLastAutoHeal: s.lastAutoHealAt ? now - s.lastAutoHealAt : null,
          msSinceStalledStart: s.stalledSinceMs ? now - s.stalledSinceMs : null,
          zombieSuspected,
          stalledPipeline,
          // 2026-05-04: reconnect lifecycle
          reconnectAttempts: s.reconnectAttempts,
          msSinceLastReconnect: s.lastReconnectAt ? now - s.lastReconnectAt : null,
          // Tail of recent transitions — bounded to last 10 to keep snapshot
          // payload small. Caller can fetch full history if needed.
          recentReconnects: s.reconnectHistory.slice(-10),
          // Sliding 5-min count for flap detection.
          reconnectsInWindow: s.recentReconnectTimestamps.filter((t) => t >= now - FLAPPING_WINDOW_MS).length,
          // 2026-05-06 v4: client generation + zombie-rebirth attribution.
          // Cross-reference with autoheal.* events: 27 reinits with
          // `currentGenOpened: false` = the exact 5h-zombie pattern.
          clientGen: s.clientGen,
          msSinceClientGen: s.clientGenStartedAt ? now - s.clientGenStartedAt : null,
          currentGenOpened: s.currentGenOpened,
          msSinceCurrentGenOpened: s.currentGenOpenedAt ? now - s.currentGenOpenedAt : null,
          reinitZombieRebirthCount: s.reinitZombieRebirthCount,
          msSinceLastReinitZombieRebirth: s.lastReinitZombieRebirthAt ? now - s.lastReinitZombieRebirthAt : null,
          // 2026-05-06 v5: rebirth streak + permanent-stop flag for autoheal.
          // operatorReeairRequired is the at-a-glance ops signal.
          consecutiveRebirthCount: s.consecutiveRebirthCount,
          autoHealPermanentlyStopped: s.autoHealPermanentlyStopped,
          msSinceAutoHealPermanentStop: s.autoHealPermanentStopAt ? now - s.autoHealPermanentStopAt : null,
          operatorRepairRequired: s.autoHealPermanentlyStopped,
          // Live listener counts. If these climb without bound across
          // clientGens, we have an event-emitter leak (the v4 fix in
          // BaileysStartupService.createClient should keep them flat).
          evListenerCount: this.safeReadCounts(s.evListenerCount),
          wsListenerCount: this.safeReadCounts(s.wsListenerCount),
          // Last fetch error stashed by global-fetch-instrument (URL +
          // host + message). Helps correlate undici "terminated" cascades
          // with the specific media or webhook URL that broke.
          lastFetchError: s.lastFetchError,
        };
      }),
      thresholds: {
        zombieGapMs: ZOMBIE_GAP_MS,
        autoHealEnabled: AUTO_HEAL_ENABLED,
        autoHealAfterMs: AUTO_HEAL_AFTER_MS,
        autoHealCooldownMs: AUTO_HEAL_COOLDOWN_MS,
        autoHealGiveupAfter: AUTO_HEAL_GIVEUP_AFTER,
        autoHealRebirthStopAfter: AUTO_HEAL_REBIRTH_STOP_AFTER,
        heartbeatMs: HEARTBEAT_MS,
        reconnectFastpathEnabled: RECONNECT_FASTPATH_ENABLED,
        reconnectFastpathAfterMs: RECONNECT_FASTPATH_AFTER_MS,
        flappingThreshold: FLAPPING_THRESHOLD,
        flappingWindowMs: FLAPPING_WINDOW_MS,
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
          // 2026-05-06 v5: hard-stop when too many consecutive rebirths.
          // No more reinits — those only worsen WhatsApp's anti-abuse flag.
          // Reset path: a healthy connection.update {open} clears the flag.
          !state.autoHealPermanentlyStopped &&
          state.stalledSinceMs !== null &&
          now - state.stalledSinceMs >= AUTO_HEAL_AFTER_MS &&
          (state.lastAutoHealAt === null || now - state.lastAutoHealAt >= AUTO_HEAL_COOLDOWN_MS) &&
          typeof state.forceClose === 'function'
        ) {
          const stalledForMs = now - state.stalledSinceMs;
          state.lastAutoHealAt = now;
          state.autoHealCount += 1;
          state.autoHealStreak += 1;
          forensic({
            kind: 'autoheal.fire',
            instance: inst.name,
            stalledForMs,
            autoHealCount: state.autoHealCount,
            autoHealStreak: state.autoHealStreak,
            reason: inst.stalledPipeline ? 'stalled-pipeline' : 'zombie-suspected',
          }).catch(() => {});
          if (state.autoHealStreak >= AUTO_HEAL_GIVEUP_AFTER && !state.autoHealGiveupEmitted) {
            state.autoHealGiveupEmitted = true;
            forensic({
              kind: 'autoheal.giveup',
              instance: inst.name,
              autoHealStreak: state.autoHealStreak,
              giveupAfter: AUTO_HEAL_GIVEUP_AFTER,
              stalledForMs,
              hint: 'auth-state likely unrecoverable; operator re-pair (logout + QR) probably required',
              lastWsClose: inst.lastWsClose,
              lastConnectionUpdate: inst.lastConnectionUpdate,
            }).catch(() => {});
          }
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
        (event as any).url ? String((event as any).url) : undefined,
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
