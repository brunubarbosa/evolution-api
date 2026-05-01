// G3: track in-flight outbound + DB work so that when an
// uncaughtException/unhandledRejection or pipeline.stalled fires, we can
// attribute it to the specific instance + URL + event + Prisma op that
// triggered it.
//
// History:
// - v1 (2026-04-30): added 'webhook' tracking after the undici "terminated"
//   stack pointed only at Node internals; we had to deduce the rest.
// - v2 (2026-05-01): added 'prisma' and 'fetch' tracking after the
//   chatbot-fan-out pool-exhaustion zombie. The 9 wedged Prisma queries
//   were invisible to v1; we found them by hand-running pg_stat_activity.

export type InFlightKind = 'webhook' | 'baileys.fetch' | 'fetch' | 'prisma' | 'other';

export interface InFlight {
  id: number;
  startedAt: number;
  kind: InFlightKind;
  instance?: string | null;
  url?: string;
  event?: string;
  attempt?: number;
  origin?: string;
  // prisma-specific
  model?: string;
  op?: string;
  // shared (small caller hint)
  hint?: string;
  // bounded stack so we know where the await is parked
  stack?: string;
}

let nextId = 1;
const inflight = new Map<number, InFlight>();
const MAX_DUMP = Number(process.env.FORENSIC_INFLIGHT_DUMP_MAX) || 200;

export function startInFlight(entry: Omit<InFlight, 'id' | 'startedAt'>): number {
  const id = nextId++;
  inflight.set(id, { ...entry, id, startedAt: Date.now() });
  return id;
}

export function endInFlight(id: number): void {
  inflight.delete(id);
}

export function dumpInFlight(): Array<InFlight & { ageMs: number }> {
  const now = Date.now();
  return Array.from(inflight.values())
    .map((e) => ({ ...e, ageMs: now - e.startedAt }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, MAX_DUMP);
}

export function inFlightStats() {
  const now = Date.now();
  const byKind: Record<string, number> = {};
  let oldestMs = 0;
  let oldestKind: string | null = null;
  for (const e of inflight.values()) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const age = now - e.startedAt;
    if (age > oldestMs) {
      oldestMs = age;
      oldestKind = e.kind;
    }
  }
  return { total: inflight.size, byKind, oldestMs, oldestKind };
}
