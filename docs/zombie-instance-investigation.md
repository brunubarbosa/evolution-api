# Zombie Instance Investigation — figurinha-bot-02

**Last updated:** 2026-04-30
**Status:** Patch deployed (forensic v2 + Baileys mutex timeout). Long-term fix pending Baileys v7.0.0 stable.

This document is the source of truth for the silent-freeze investigation that consumed 2026-04-30. It captures: what we observed, what we tried, what was wrong about each fix, and what the actual root cause is. Read this before touching `src/forensic/*`, `patches/*`, or the eventHandler in `whatsapp.baileys.service.ts` — the wrong reflex is to "simplify" things that look weird but are load-bearing.

## TL;DR

The bot looks healthy (container `Up`, DB says `open`) but stops processing messages. WhatsApp tears down the connection ~10 min later. We chased it through three theories before landing on the real one:

1. ❌ **First theory:** an undici `terminated` exception killed our event handlers. Patched G4 (handler hardening) — bot stalled again 50 min later, no exception in sight.
2. ❌ **Second theory:** our forensic detector was off by 1 second (10 min threshold, real stalls happen at 9m59s). Lowering threshold would have detected — but not fixed — the bug.
3. ✅ **Real cause:** Baileys' internal `processingMutex` (`src/Utils/make-mutex.ts`) has no timeout. When any awaited operation inside its critical section hangs (most likely a Prisma `keys.get/set` for the Signal session store, hammered by a post-reconnect skmsg flood), every subsequent message handler queues forever. **This is a known upstream bug**, fixed by Baileys PR #2137 + #2151 (merged 2025-12-12, unreleased). Latest published Baileys is still rc.9.

Our shipped fix is a **patch-package patch** that adds a 60s `Promise.race` timeout to `makeMutex` — a band-aid version of upstream PR #2151 that we drop the day v7.0.0 stable ships.

## The incident timeline (2026-04-30)

| Time (UTC) | Event |
|---|---|
| 20:25:08 | bot-02 connects normally on the previous container |
| 20:41:21 | WS close `503 Stream Errored`, instant reconnect → `open` |
| 20:44:45.245 | Last successful webhook (200 OK) |
| 20:44:45.586 | `uncaughtException: TypeError: terminated` from `undici Fetch.onAborted` |
| 20:44 → 21:11 | **Apparent zombie #1**: WS frames flow (`ws.message` count 3,439 → 11,527). `messages.upsert` count frozen at 572. Zero webhooks fire. |
| 21:11:56 | WhatsApp gives up: `ws.close` code 1006 (abnormal) |
| 21:11:56 → 22:21 | Total silence. No reconnect attempted. |
| 22:21 | We restart the container. Forensic v2 patch deployed. |
| 22:58 | Container recreated on patched image. Healthy. |
| 23:38 (approx) | Last Baileys event in pid 197 (a `creds.update`) |
| 23:38 → 23:49 | **Zombie #2**: same pattern. WS frames flow, `messages.upsert` frozen at 134. **No exception thrown. handlerErrorCount: 0.** Forensic v2 detector did not fire (gap was 9m59s, threshold 10min). |
| 23:49:45 | WhatsApp tears down: `connection: close` `statusCode: 500 — Stream Errored (ack)` |
| 23:49:46 | Auto-reconnect → brief activity burst → re-stalls |

Two distinct zombie episodes within hours of each other, both invisible to forensic v1.

## What forensic v1 caught vs missed

**Caught (correctly):**
- The original 20:44 `uncaughtException` with full stack — pointed at undici Fetch terminating on TLS socket close
- The 27-minute window where `ws.message` count climbed but `messages.upsert` froze
- The `state-snapshot.json` last-will-and-testament

**Missed (gaps):**
- **G1.** `wsReadyState` getter returned `null` because Baileys wraps the WS — not a real bug, but cosmetic confusion in heartbeats.
- **G2.** A single `lastActivityAt` field bumped on `ws.message` AND on `messages.upsert`. The 27 min of silent stall registered as `msSinceLastActivity: 13–127ms` because raw frames kept bumping it. **The detector was structurally blind to the real signal.**
- **G3.** `uncaughtException` snapshot didn't capture which webhook/fetch was in flight. Stack pointed at Node internals; the URL/instance/event was lost.
- **G4.** Fire-and-forget Baileys handlers (`chats.update`, `contacts.upsert`, `groups.*`) returned promises that nobody awaited. One async rejection became `uncaughtException`.

## Forensic v2 — what we shipped and why each piece exists

Commit `00bd375` on `feat/forensic-v2`, deployed 2026-04-30 22:58.

### G2 — separate Baileys-event tracking from raw WS frames

`src/forensic/instance-tracker.ts`:

```ts
lastBaileysEventAt: number | null;   // bumps on messages.upsert/chats/contacts/creds
lastWsMessageAt:    number | null;   // bumps on raw ws.message
```

The new `pipeline.stalled` heartbeat event fires when WS frames flow (`msSinceLastWsMessage < 60s`) but Baileys events stop (`msSinceLastBaileysEvent > ZOMBIE_GAP_MS`). This is **the exact signature** of the bug. It's structurally impossible to detect with a single timestamp.

**Known false-negative:** the threshold defaults to 10 min. The 23:38 stall barely missed it (9m59s). Lower to 3 min in production.

### G3 — in-flight outbound HTTP tracker

`src/forensic/in-flight.ts` — a `Map<id, {kind, instance, url, event, startedAt}>`. `webhook.controller.ts` calls `startInFlight()` before each axios POST and `endInFlight(id)` after. On `uncaughtException`/`unhandledRejection` (`config/error.config.ts`), `dumpInFlight()` is included in the snapshot.

This only covers **our** outbound calls (axios webhooks). It does **not** instrument Baileys' internal `fetch` calls (media downloads, profile pics) — those would need patching Baileys itself or wrapping `globalThis.fetch`. **Future work.**

### G4 — harden fire-and-forget Baileys handlers

`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts:1939–2123`:

```ts
const safe = (handler, p) => {
  if (!p?.then) return;
  p.catch(err => instanceTracker.recordHandlerError(this.instance.name, { handler, error }));
};
// ...
safe('chats.update', this.chatHandle['chats.update'](payload));   // was: fire-and-forget
```

Plus a belt-and-braces `.catch()` on the outer `eventProcessingQueue` chain so even if a `safe()` is missed somewhere, the queue self-heals.

**Important:** G4 is a real fix for the *uncaughtException-class* of zombie. It would have prevented the 20:44 incident entirely. **It is NOT what fixes the 23:38 incident** — that was a Baileys-internal hang, not an Evolution-side rejection. But G4 stays. We were leaking promises and that needed fixing.

## The deeper investigation — why G2/G3/G4 weren't enough

After the 23:38 stall reproduced cleanly with v2 deployed and `handlerErrorCount: 0`, we knew the bug wasn't an exception at all. We dispatched four specialist agents in parallel to investigate:

1. **Baileys WS/mutex/buffer** — concurrency primitives
2. **WhatsApp protocol/decrypt** — Signal session ops, ack flow
3. **Evolution integration** — what callbacks Baileys awaits from us
4. **Git archaeology** — prior issues, merged-but-unreleased fixes

All four converged independently on the same diagnosis. Highlights:

### The smoking gun: `make-mutex.ts`

```ts
// node_modules/baileys/lib/Utils/make-mutex.js — 29 lines, unchanged since 2023
mutex<T>(code: () => Promise<T> | T): Promise<T> {
  task = (async () => {
    try { await task } catch {}
    try { return await code() }       // ← no Promise.race, no timeout, no AbortController
    finally { clearTimeout(taskTimeout) } // ← taskTimeout is dead code, never assigned
  })();
  return task;
}
```

`taskTimeout` is declared (line 5) and cleared (line 21) but never assigned anywhere. The `finally` is a placeholder for a feature that was never built. Every queued caller awaits `task`. **If any single `code()` invocation never resolves, every subsequent `.mutex()` call queues forever.**

### Why this triggers in our profile

A figurinha (sticker) bot in many groups has a specific failure-mode amplifier. After any reconnect:

1. WhatsApp re-delivers buffered group messages → flood of "skmsg" stanzas → flood of "No session found to decrypt message" errors (visible in our prod logs).
2. Each failure enters the retry path at `messages-recv.ts:1238`:
   ```
   await processingMutex.mutex(async () => {
     await decrypt()                              // hits Signal session store
     if (CIPHERTEXT) {
       await retryMutex.mutex(async () => {       // ← nested mutex inside outer
         await uploadPreKeys(5)                   // hits authState.keys
         await delay(1000)
         await sendRetryRequest(node, !encNode)
         await delay(retryRequestDelayMs)
         await sendMessageAck(node, NACK_REASONS.UnhandledError)
       })
     }
   })
   ```
3. Every awaited `keys.get/set` in that chain backs onto Evolution's Prisma client. Evolution's `useMultiFileAuthStatePrisma` has **no per-call timeout**. With the connection pool saturated under retry storm, a stuck Prisma query parks the await forever. PgBouncer transaction-mode half-open sockets are a known cause.
4. Once one `.mutex()` call hangs, every subsequent message handler queues forever. WS keeps receiving frames; `processNodeWithBuffer` in Baileys keeps calling `ev.buffer()` → events accumulate, `ev.flush()` is never reached.
5. WhatsApp's flow-control window expires (~30–60s of un-acked traffic) → server kills stream with `Stream Errored (ack) 500`.
6. Auto-reconnect creates a fresh socket *and a fresh mutex chain*. Brief recovery. Then the same code path runs against the same flaky Prisma connection and re-hangs.

This matches our forensic data exactly:
- Frames flow ✓
- `messages.upsert` frozen ✓
- No exception thrown ✓
- `handlerErrorCount: 0` ✓
- `Stream Errored (ack)` 500 disconnect at the right cadence ✓
- Brief recovery on reconnect, then re-stall ✓

### Upstream prior art

Multiple Baileys issues describe this exact failure mode:

| Issue/PR | Status | Notes |
|---|---|---|
| #1879 | Open | "messages.upsert event not triggered under high message load" — rc.5 onward |
| #2271 | Open | "messages.upsert not working after panel auto restart" — rc.8 |
| #1910 | Open | "Error 500 - Stream Errored (ack)" — same disconnect symptom |
| #2450 | Open | "Stream Errored (ack) after 50–60 minutes" — exact periodicity |
| #2491 | Open | "Sessions go 'deaf' after 30+ minutes" — direct match including reconnect re-stall |
| #2103 | Closed (rejected by author as band-aid) | "Stop awaiting retry mutex to fix message hang" |
| **#2137** | **Merged 2025-12-12, unreleased** | Splits processingMutex into 4 dedicated mutexes (message/receipt/appStatePatch/notification) |
| **#2151** | **Merged 2025-12-12, unreleased** | Replaces hand-rolled makeMutex with `async-mutex`'s Mutex (also fixes a 15MB/100msg memory leak) |

**The bug was diagnosed correctly upstream and the fix is already merged on `master`. There is no rc.10 yet.** Latest tag is still `v7.0.0-rc.9` from 2025-11-21.

### The lint regression that caused all of this

PR #2073 ("no-floating-promises") added `await` eagerly to `messages-recv.ts` paths to satisfy a lint rule. Crucially, it added `await retryMutex.mutex(...)` *inside* the outer `processingMutex.mutex(...)` block (line 1221 and 1238 of compiled JS). The nested-mutex hold is what makes the deadlock so reliable. Before #2073 these were fire-and-forget; the lint rule was correct that they SHOULD have been awaited, but the change exposed that the mutex implementation couldn't safely handle awaited nesting under load.

## What we shipped (the patch)

`patches/baileys+7.0.0-rc.9.patch` — applied via `patch-package` postinstall hook.

**Diff scope:** `node_modules/baileys/lib/Utils/make-mutex.js` only.

**Behavior:** wraps `await code()` with `Promise.race` against a configurable timeout (`BAILEYS_MUTEX_TIMEOUT_MS`, default 60000). On timeout:
1. The held slot rejects with `MutexTimeoutError`.
2. The next queued caller's `try { await task } catch {}` swallows the rejection and proceeds.
3. The runaway `code()` promise is intentionally **leaked** — it's still running its hung await in the background, but no longer blocks the queue.

```diff
+const DEFAULT_MUTEX_TIMEOUT_MS = Number(process.env.BAILEYS_MUTEX_TIMEOUT_MS) || 60000;
+class MutexTimeoutError extends Error { ... }
 export const makeMutex = () => {
     let task = Promise.resolve();
     return {
         mutex(code) {
             task = (async () => {
                 try { await task } catch { }
+                let timer;
+                const timeoutPromise = new Promise((_, reject) => {
+                    timer = setTimeout(() => reject(new MutexTimeoutError(...)), ...);
+                });
                 try {
-                    return await code();
+                    return await Promise.race([code(), timeoutPromise]);
-                } finally { clearTimeout(taskTimeout); }
+                } finally { if (timer) clearTimeout(timer); }
             })();
             return task;
         }
     };
 };
```

**Trade-offs vs upstream PR #2151:**
- ✅ Tiny diff (~15 lines), trivial to review
- ✅ Drop-in: same public API, no breaking changes
- ✅ Auto-removed when we upgrade to v7.0.0 stable (delete patch file)
- ❌ Doesn't replicate PR #2151's memory-leak fix (we'd need `async-mutex` lib for that)
- ❌ Doesn't replicate PR #2137's mutex split (single global mutex still has contention; only deadlock is fixed)
- ⚠️ Leaks the runaway promise — the broken `keys.get/set` is still pending in memory. With many failures this accumulates. Acceptable for the deadlock fix; revisit if heap grows pathologically.

**Smoke tested locally:**
- Empty mutex: returns 42 ✓
- `m.mutex(() => new Promise(() => {}))` (stuck) rejects with `MutexTimeoutError` after configured ms ✓
- Next queued call unblocks and runs ✓

## What we did NOT fix (and probably should)

These are real gaps. Pick one when this comes back:

### 1. Per-call timeout on `authState.keys.get/set` (Evolution-side)

The mutex is the amplifier; the keystore is the **actual hang site**. Even with the mutex timeout, every 60s a different message will trigger another timeout if Prisma stays sick. Cleaner: wrap each `keys.get/set` in `Promise.race([query, timeout(15s)])`. A 15s Prisma timeout that throws is much better than a 60s mutex timeout that leaks the promise.

File: `src/utils/use-multi-file-auth-state-prisma.ts`. Both `get` and `set` need it.

### 2. Watchdog auto-heal

Lower `FORENSIC_ZOMBIE_GAP_MS` from 600000 (10 min) to 180000 (3 min). When `pipeline.stalled` fires and persists for >180s, force `client.ws.close()` so Baileys reconnects with a fresh mutex. Behind a `FORENSIC_AUTO_HEAL=true` flag so we keep diagnostic-only mode for now and enable after a week of clean baseline.

File: `src/forensic/instance-tracker.ts`, `startHeartbeat()`.

### 3. Track Baileys' own in-flight fetches

G3 only covers our axios calls. Baileys uses `globalThis.fetch` (undici) for media downloads, profile pics, and IQ replies. A patch-package patch to add `startInFlight`/`endInFlight` calls inside Baileys' fetch wrappers would close the visibility gap. Or wrap `globalThis.fetch` in a top-level instrumentation file.

### 4. Upgrade to Baileys v7.0.0 stable when it ships

Then **delete the patch file** and the `postinstall` hook (or keep `patch-package` empty as a guardrail). PRs #2137 + #2151 land in stable. Our problem goes away upstream.

Watch: https://github.com/WhiskeySockets/Baileys/releases

## Operations runbook

### How to deploy a new image

```bash
# Local
cd /Users/brunobarbosa/Desktop/projects/whatsapp/evolution-api
git checkout feat/baileys-patch  # or main once merged
SHA=$(git rev-parse --short HEAD)
gh auth token | docker login ghcr.io -u brunubarbosa --password-stdin
docker buildx build --platform linux/amd64 --push \
  -t ghcr.io/brunubarbosa/evolution-api:v2.3.7-sticker-forensic \
  -t ghcr.io/brunubarbosa/evolution-api:sha-$SHA .

# VPS
ssh root@157.90.233.12
cd /data/coolify/services/yxrk4h8hy4tg5vpeaj11qx47
docker pull ghcr.io/brunubarbosa/evolution-api:v2.3.7-sticker-forensic
# Save current image as rollback target before recreating
docker tag $(docker inspect api-yxrk4h8hy4tg5vpeaj11qx47 --format '{{.Image}}') \
  ghcr.io/brunubarbosa/evolution-api:v2.3.7-sticker-forensic-prev
docker compose up -d api
```

Note: Coolify owns the compose file. The fork-Action workflow at `.github/workflows/publish_ghcr_fork.yml` exists but currently 403's on push because the GHCR package was created by manual push and Actions doesn't own it. To fix: GHCR package settings → Manage Actions access → grant the repo `write`. Until then, build locally as above.

### How to confirm the patch is live

```bash
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 \
  grep -c MutexTimeoutError /evolution/node_modules/baileys/lib/Utils/make-mutex.js
# Should print: 2
```

### How to verify the patch is doing useful work

The patch prints nothing on quiet operation. When a real hang is unblocked you'll see in `forensic.jsonl`:

```json
{"kind":"baileys.handler.error","handler":"<some Evolution handler>", ...}
```

… combined with a stack containing `MutexTimeoutError`. Or — if the timeout fires inside Baileys' own retry path with no Evolution handler downstream — Baileys' own logger (pino, stderr) will emit a warning. Tail container logs:

```bash
docker logs -f api-yxrk4h8hy4tg5vpeaj11qx47 2>&1 | grep -iE "mutex|timeout|stall"
```

### How to roll back

```bash
ssh root@157.90.233.12
docker tag ghcr.io/brunubarbosa/evolution-api:v2.3.7-sticker-forensic-prev \
           ghcr.io/brunubarbosa/evolution-api:v2.3.7-sticker-forensic
docker compose -f /data/coolify/services/yxrk4h8hy4tg5vpeaj11qx47/docker-compose.yml up -d api
```

### How to read the forensic data

See `docs/forensic.md`.

Quick ones:
```bash
# Anyone zombie right now?
ssh root@157.90.233.12 \
  'jq -c ".payload.instances[] | select(.zombieSuspected or .stalledPipeline)" \
   /data/coolify/figurinha-evolution/forensic/state-snapshot.json'

# Histogram of event kinds in current process
ssh root@157.90.233.12 \
  "jq -r 'select(.pid == \$(docker inspect api-yxrk4h8hy4tg5vpeaj11qx47 --format \"{{.State.Pid}}\")) | .kind' \
   /data/coolify/figurinha-evolution/forensic/forensic.jsonl | sort | uniq -c | sort -rn"

# Tail human-readable
tail -f /data/coolify/figurinha-evolution/forensic/forensic.jsonl | jq -c '{ts, kind, instance}'
```

## Open questions / things to validate when this comes back

- [ ] Is the **next** zombie episode bounded at 60s by our mutex timeout? If yes, the patch works as designed. If no, something else is hanging.
- [ ] After a timeout fires, does the runaway promise leak measurably grow heap over hours? If yes, ship the keystore-side timeout (deeper fix #1 above).
- [ ] Does the patch-package postinstall fire reliably in Docker builds? Verified once on 2026-04-30; verify again if Dockerfile changes.
- [ ] When Baileys v7.0.0 stable ships, run a clean install and confirm `make-mutex.js` already has a timeout — then delete `patches/baileys+7.0.0-rc.9.patch` and the `postinstall` hook.
- [ ] Optional: post a comment on Baileys issue #2491 with our forensic timeline + the proof that the auth-state layer is the underlying culprit (independent of the mutex). Helps maintainers prioritize a v7.0.0-stable backport.

## File map

What touches what:

| File | Role |
|---|---|
| `src/forensic/instance-tracker.ts` | G2 detector logic, heartbeat, zombie/pipeline-stalled detection |
| `src/forensic/forensic-logger.ts` | JSONL append + state-snapshot writer (sync + async variants) |
| `src/forensic/in-flight.ts` | G3 outbound-fetch tracker |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | G4 `safe()` wrapper around fire-and-forget handlers; raw WS hooks |
| `src/api/integrations/event/webhook/webhook.controller.ts` | G3 wiring on axios webhook calls |
| `src/config/error.config.ts` | uncaughtException / unhandledRejection / signal handlers; dumps in-flight + snapshot |
| `src/main.ts` | starts heartbeat, emits `process.boot` |
| `patches/baileys+7.0.0-rc.9.patch` | mutex timeout patch (THIS PATCH FIXES THE ACTUAL BUG) |
| `package.json` | `postinstall: patch-package`, `patch-package` devDep |
| `Dockerfile` | `COPY ./patches ./patches` before `npm ci` so postinstall has them |
| `docs/forensic.md` | operational guide for using forensic output |
| `docs/zombie-instance-investigation.md` | this file |

## Key code references (Baileys 7.0.0-rc.9)

For when you want to read the actual upstream code at the failure sites:

- `src/Utils/make-mutex.ts` (29 lines, 1:1 with compiled JS): the mutex without a timeout
- `src/Utils/event-buffer.ts` lines 88–108: `buffer()` — auto-flush is per-cycle, not per-frame
- `src/Socket/messages-recv.ts` lines 1171–1318: `handleMessage` — the holder of `processingMutex`
- `src/Socket/messages-recv.ts` line 1238: `await retryMutex.mutex(...)` nested inside processingMutex
- `src/Socket/messages-recv.ts` line 1415: `processNodeWithBuffer` — calls `ev.buffer()` then awaits `execTask()`
- `src/Socket/socket.ts` line 569: `onMessageReceived` — the WS-frame entry point
- `src/Socket/socket.ts` line 953: `CB:stream:error` — where the `Stream Errored (ack)` 500 comes from
- `src/Utils/auth-utils.ts` line 272: `transaction` wrapper — every Signal op goes through this; per-key mutex with no timeout

Local clone for reference: `/Users/brunobarbosa/Desktop/projects/whatsapp/baileys-source` (tag `v7.0.0-rc.9`).
