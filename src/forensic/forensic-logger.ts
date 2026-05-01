import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { appendFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DIR = process.env.FORENSIC_LOG_DIR || '/evolution/forensic';
const ROTATE_BYTES = Number(process.env.FORENSIC_ROTATE_BYTES) || 10 * 1024 * 1024;
const KEEP = Number(process.env.FORENSIC_KEEP_FILES) || 5;
const FILE = join(DIR, 'forensic.jsonl');
const SNAPSHOT_FILE = join(DIR, 'state-snapshot.json');

let ensured = false;
function ensureDir() {
  if (ensured) return;
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    ensured = true;
  } catch {
    // best-effort; subsequent writes will retry
  }
}

function maybeRotate() {
  try {
    if (!existsSync(FILE)) return;
    const size = statSync(FILE).size;
    if (size < ROTATE_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const src = join(DIR, `forensic.${i}.jsonl`);
      const dst = join(DIR, `forensic.${i + 1}.jsonl`);
      if (existsSync(src)) {
        if (i + 1 > KEEP) unlinkSync(src);
        else renameSync(src, dst);
      }
    }
    renameSync(FILE, join(DIR, 'forensic.1.jsonl'));
  } catch {
    // swallow — never break the app over forensic IO
  }
}

export type ForensicEvent = {
  kind: string;
  instance?: string | null;
  [key: string]: unknown;
};

// 2026-05-01 v3.1: in-process observers. Allows the InstanceTracker to
// receive copies of every forensic event (including ones written by code
// outside the TS tree, like the Baileys mutex patch in node_modules) so its
// snapshot counters stay in sync without polling JSONL on disk. Subscribers
// MUST be synchronous and never throw — they run on the hot path.
type ForensicObserver = (event: ForensicEvent) => void;
const observers: ForensicObserver[] = [];
export function subscribeForensic(fn: ForensicObserver): () => void {
  observers.push(fn);
  return () => {
    const i = observers.indexOf(fn);
    if (i >= 0) observers.splice(i, 1);
  };
}
function notifyObservers(event: ForensicEvent): void {
  for (const fn of observers) {
    try {
      fn(event);
    } catch {
      /* observers must never break the hot path */
    }
  }
}

export async function forensic(event: ForensicEvent): Promise<void> {
  notifyObservers(event);
  ensureDir();
  maybeRotate();
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...event,
    }) + '\n';
  try {
    await appendFile(FILE, line);
  } catch {
    // disk full / permission — last resort to stderr so we don't lose it entirely
    try {
      process.stderr.write(`[forensic-fallback] ${line}`);
    } catch {
      /* noop */
    }
  }
}

// Synchronous variant for shutdown handlers (uncaughtException, SIGTERM)
// where the event loop will not drain pending appendFile promises.
export function forensicSync(event: ForensicEvent): void {
  notifyObservers(event);
  ensureDir();
  maybeRotate();
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...event,
    }) + '\n';
  try {
    appendFileSync(FILE, line);
  } catch {
    try {
      process.stderr.write(`[forensic-fallback] ${line}`);
    } catch {
      /* noop */
    }
  }
}

export async function writeSnapshot(payload: unknown): Promise<void> {
  ensureDir();
  try {
    await writeFile(
      SNAPSHOT_FILE,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, payload }, null, 2),
    );
  } catch {
    /* noop */
  }
}

export function writeSnapshotSync(payload: unknown): void {
  ensureDir();
  try {
    writeFileSync(SNAPSHOT_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, payload }, null, 2));
  } catch {
    /* noop */
  }
}

export const FORENSIC_PATHS = { dir: DIR, file: FILE, snapshot: SNAPSHOT_FILE };
