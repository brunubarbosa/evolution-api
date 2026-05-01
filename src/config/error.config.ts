import { forensicSync, writeSnapshotSync } from '@forensic/forensic-logger';
import { dumpInFlight } from '@forensic/in-flight';
import { instanceTracker } from '@forensic/instance-tracker';

import { Logger } from './logger.config';

function captureFinalState(reason: string, extra?: Record<string, unknown>) {
  try {
    const snap = instanceTracker.snapshot();
    const inflight = dumpInFlight();
    // 2026-05-01 v3.1: include the in-memory ring of recent forensic events
    // so the post-mortem is self-contained even if disk JSONL has rotated
    // out (10MB × 3 keep ≈ 10min retention under verbose pino debug load).
    const ringTail = instanceTracker.ringTail(100);
    writeSnapshotSync(snap);
    forensicSync({ kind: `process.${reason}`, ...(extra ?? {}), inflight, ringTail, snapshot: snap });
  } catch {
    /* noop */
  }
}

export function onUnexpectedError() {
  process.on('uncaughtException', (error, origin) => {
    const logger = new Logger('uncaughtException');
    logger.error({
      origin,
      stderr: process.stderr.fd,
      error,
    });
    captureFinalState('uncaughtException', {
      origin: String(origin),
      error: { message: error?.message, name: error?.name, stack: error?.stack },
    });
  });

  process.on('unhandledRejection', (error, origin) => {
    const logger = new Logger('unhandledRejection');
    logger.error({
      origin,
      stderr: process.stderr.fd,
    });
    logger.error(error);
    captureFinalState('unhandledRejection', {
      reason: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
  });

  // Container stop / k8s terminate / Coolify redeploy
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      captureFinalState('signal', { signal: sig });
      // Don't call process.exit here — let the upstream shutdown logic run
      // (Express server.close, prisma disconnect). We just need the forensic
      // line written before the process actually exits.
    });
  }

  process.on('beforeExit', (code) => {
    captureFinalState('beforeExit', { code });
  });

  process.on('exit', (code) => {
    // exit is fully synchronous — only forensicSync works here.
    try {
      forensicSync({ kind: 'process.exit', code });
    } catch {
      /* noop */
    }
  });
}
