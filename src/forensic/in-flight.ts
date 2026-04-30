// G3: track outbound HTTP-ish work currently in flight so that when an
// uncaughtException/unhandledRejection fires, we can attribute it to the
// specific instance + URL + event that triggered it.
//
// The 2026-04-30 incident left us with an undici "terminated" stack trace
// that pointed only at Node internals. We had to deduce the rest. This
// closes that gap.

export interface InFlight {
  id: number;
  startedAt: number;
  kind: 'webhook' | 'baileys.fetch' | 'other';
  instance?: string | null;
  url?: string;
  event?: string;
  attempt?: number;
  origin?: string;
}

let nextId = 1;
const inflight = new Map<number, InFlight>();
const MAX_DUMP = 50;

export function startInFlight(entry: Omit<InFlight, 'id' | 'startedAt'>): number {
  const id = nextId++;
  inflight.set(id, { ...entry, id, startedAt: Date.now() });
  return id;
}

export function endInFlight(id: number): void {
  inflight.delete(id);
}

export function dumpInFlight(): InFlight[] {
  const now = Date.now();
  return Array.from(inflight.values())
    .map((e) => ({ ...e, ageMs: now - e.startedAt }) as InFlight & { ageMs: number })
    .sort((a, b) => (b as any).ageMs - (a as any).ageMs)
    .slice(0, MAX_DUMP);
}
