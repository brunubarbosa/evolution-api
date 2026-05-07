// Decides whether a closed Baileys connection should reconnect, and how soon.
//
// 📘 FULL CONTEXT: docs/evolution-fork/reconnect-runbook.md (in grupodewhatsapp).
// Read it before changing the code/delay tables below. The runbook explains
// *why* each terminal vs reconnect bucket exists, the empirical disconnect-code
// distribution from our forensic data, and which incidents motivated each rule.
//
// Why: the previous logic was a tiny blacklist (`!codesToNotReconnect.includes(...)`)
// that reconnected immediately for every recoverable code. Two real-world failure
// modes that exposed:
//   1. `connectionReplaced` (440) was missing from the blacklist, so a "another
//      device paired" event triggered an infinite reconnect loop instead of
//      surfacing a re-auth prompt to the user.
//   2. No backoff: a flapping WhatsApp endpoint got hammered with reconnects
//      every few seconds, occasionally tripping server-side rate-limits.
//
// This classifier returns an explicit decision per known DisconnectReason plus
// a sensible default for unknown codes. Callers apply exponential backoff over
// `baseDelayMs` per attempt — that math lives in instance-tracker because the
// attempt counter must survive across reconnect cycles.
//
// References:
//   Baileys DisconnectReason enum:
//     baileys/src/Types/index.ts (connectionClosed=428, connectionLost=408,
//     connectionReplaced=440, timedOut=408, loggedOut=401, badSession=500,
//     restartRequired=515, multideviceMismatch=411, forbidden=403,
//     unavailableService=503)
//   Baileys DeepWiki — Error Handling and Recovery (no built-in reconnect)
//   Baileys maintainer thread (2026-05-04) — confirmed 440 must be terminal,
//   suggested 20s keepAlive, 45-60s zombie watchdog. Aligned with our impl.

import { DisconnectReason } from 'baileys';

export type DisconnectDecision =
  | { action: 'reconnect'; reason: string; baseDelayMs: number }
  | { action: 'terminal'; reason: string };

interface ErrorData {
  tag?: string;
  attrs?: { type?: string };
}

export function classifyDisconnect(
  statusCode: number | undefined | null,
  errorData?: ErrorData | null,
): DisconnectDecision {
  // ─────────────── TERMINAL — pairing required ───────────────
  if (statusCode === DisconnectReason.loggedOut) {
    return { action: 'terminal', reason: 'logged-out' };
  }
  if (statusCode === DisconnectReason.connectionReplaced) {
    return { action: 'terminal', reason: 'connection-replaced' };
  }
  if (statusCode === DisconnectReason.forbidden) {
    return { action: 'terminal', reason: 'forbidden' };
  }
  if (statusCode === DisconnectReason.multideviceMismatch) {
    return { action: 'terminal', reason: 'multidevice-mismatch' };
  }
  // 401 + Boom data { tag: 'conflict', attrs.type: 'device_removed' } means
  // another device displaced ours. Distinct from `loggedOut`'s 401 — the Boom
  // payload is what tells us this is a conflict rather than a session expiry.
  if (statusCode === 401 && errorData?.tag === 'conflict' && errorData?.attrs?.type === 'device_removed') {
    return { action: 'terminal', reason: 'device-removed' };
  }
  // 402 = payment required (rare, business API), 406 = not acceptable.
  // Both terminal in the wild — no client-side retry resolves them.
  if (statusCode === 402 || statusCode === 406) {
    return { action: 'terminal', reason: `terminal-${statusCode}` };
  }

  // ─────────────── RECOVERABLE — reconnect with backoff ───────────────
  if (statusCode === DisconnectReason.restartRequired) {
    // 515 — WhatsApp explicitly told us to restart the stream. Fast reconnect.
    return { action: 'reconnect', reason: 'restart-required', baseDelayMs: 500 };
  }
  if (statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.timedOut) {
    // 408 — keep-alive missed or server stopped responding. Likely transient.
    return { action: 'reconnect', reason: 'connection-lost', baseDelayMs: 2_000 };
  }
  if (statusCode === DisconnectReason.connectionClosed) {
    // 428 — most common in our forensic sample. Idle-close from server.
    return { action: 'reconnect', reason: 'connection-closed', baseDelayMs: 2_000 };
  }
  if (statusCode === DisconnectReason.badSession) {
    // 500 — auth state may be partially corrupted. Slightly longer delay so
    // any in-flight Prisma/fs writes finish before we tear down + reconnect.
    return { action: 'reconnect', reason: 'bad-session', baseDelayMs: 5_000 };
  }
  if (statusCode === DisconnectReason.unavailableService) {
    // 503 — server is overloaded. Back off harder so we don't pile on.
    return { action: 'reconnect', reason: 'unavailable-service', baseDelayMs: 10_000 };
  }

  // ─────────────── UNKNOWN ───────────────
  // statusCode null/undefined means the TCP/TLS socket died before any close
  // frame — this is the bulk of our `code 1006` disconnects. Reconnect with a
  // moderate delay; usually transient network blip.
  if (statusCode === undefined || statusCode === null) {
    return { action: 'reconnect', reason: 'no-status-code', baseDelayMs: 3_000 };
  }
  // Unknown numeric code — be conservative. Long delay to avoid hammering an
  // endpoint we don't understand.
  return { action: 'reconnect', reason: `unknown-${statusCode}`, baseDelayMs: 10_000 };
}

// Backoff math + flapping guardrail live on instance-tracker — they need to
// share state across reconnect cycles, which the classifier has no access to.
