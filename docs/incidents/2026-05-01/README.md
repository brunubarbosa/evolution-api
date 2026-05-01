# 2026-05-01 — Zombie Episode 4: chatbot fan-out pool exhaustion

**Status:** Patched. Bot was zombie from 11:29 UTC to 15:01 UTC (3h32m). Restart at 15:01 recovered the instance; new code deployed in same release will catch the next occurrence.

## What happened (timeline UTC)

| Time | Event |
|---|---|
| ~10:00 | normal operation — 18 connection.update events, 9k messages.upsert |
| 11:19:09 | First Prisma SELECT to `Typebot` issued |
| 11:19:10–11 | 8 more queries pile up across 1.7s (chatbot fan-out for one inbound `messages.upsert`): Typebot, Flowise, Dify, FlowiseSetting, DifySetting, Webhook, Contact INSERT, Chat UPDATE |
| **11:19:11.077** | `process.uncaughtException: TypeError: terminated` from `undici Fetch.onAborted` (TLS socket close on outbound webhook to figurinhawhatsapp.com — same undici bug as Episode 1) |
| 11:19–11:29 | Pipeline silent. WS frames keep flowing but `messages.upsert` never increments. |
| 11:29:54 | First `pipeline.stalled` heartbeat — detector trips at 10-min threshold |
| 14:15:59 | `baileys.mutex.timeout` fires (twice) — patch v1+v2 working as designed for the *mutex* class, but bot still doesn't recover (the wedge is in pool, not mutex) |
| 15:01 | Operator restarts container after manual diagnosis |

## Root cause

**Chatbot integration fan-out + Prisma pool exhaustion + undici terminated cascade.**

Every `messages.upsert` event triggers Evolution's chatbot fan-out via `chatbot.controller.emit()`, which calls 7 sub-controllers (`evolutionBot`, `typebot`, `openai`, `dify`, `n8n`, `evoai`, `flowise`). Each sub-controller issues 1–3 Prisma `findFirst`/`findMany` queries against its own config table, **even when zero chatbots are configured** (none of the queries early-exit on a missing config row — they always run to check).

For figurinha-bot-02 (zero chatbots configured) this means **9+ Prisma queries per inbound message**, on top of `Webhook.findFirst`, `Contact.upsert`, and `Chat.update` issued by the message-event handler itself.

When the outbound webhook to `https://figurinhawhatsapp.com/api/webhooks/evolution` hit a TLS-closed socket, `undici` threw `TypeError: terminated` from `Fetch.onAborted`. The unhandled exception fired *while* nine Prisma queries were mid-roundtrip. Their continuations were aborted by Node's microtask scheduler, but Postgres had already executed the queries and was sitting in `idle/ClientRead` waiting for the next command. The Node-side connection sockets stayed alive but Prisma's awaiting promises were rejected and never settled — leaving Prisma's pool entries marked "in use" while Postgres saw them as idle.

Default Prisma pool size is `(num_cpus * 2) + 1` ≈ 9. All 9 wedged simultaneously. Every subsequent `messages.upsert` queued waiting for a free slot. The bot zombied.

### Why patch v3 (auth-state timeout) didn't help

Patch v3 wraps `useMultiFileAuthStatePrisma`'s I/O calls (`prisma.session.findUnique`, `prisma.session.upsert` for creds). The wedged queries here are **chatbot integration table reads + webhook config + Contact/Chat upserts** — none of which go through the auth-state module. v3's `Promise.race` timeout never fires for them. Confirmed: zero `authstate.io.timeout` events emitted during the 3h32m freeze.

### Why mutex timeouts (patch v1+v2) didn't recover

Two `baileys.mutex.timeout` events fired during the freeze (at 14:15:59 UTC). The mutex slot was released, but the upstream wedge is in **the chatbot fan-out + pool**, not in Baileys' Signal session decrypt. Releasing the mutex didn't free the pool. The next message handler queued on a still-empty pool and re-stalled instantly.

## What we shipped

### A. Prisma per-call timeout (`PrismaRepository`)

`src/api/repository/repository.service.ts` — wraps every read operation (`findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`) on every model delegate with `Promise.race` against `PRISMA_QUERY_TIMEOUT_MS` (default 30s). On timeout:

- emits `prisma.timeout` forensic event with `{model, op, args.shape, inflight, stack}`
- rejects the await — caller can fail-fast instead of queuing forever

**Limitation:** mutations (`create`, `update`, `upsert`, `delete`) are **not** wrapped, because they're sometimes batched via `prisma.$transaction([promiseA, promiseB])` and converting them to plain Promises breaks transaction batching (see `whatsapp.baileys.service.ts:1000` for the contact-upsert example). All nine queries wedged in this incident were either reads or solo mutations outside any `$transaction`, so this still catches the bulk of the failure surface.

### B. Chatbot fan-out short-circuit

`src/api/integrations/chatbot/chatbot.controller.ts` — `emit()` now precedes the 7-controller fan-out with `anyChatbotEnabled(instanceId)`, a cached `Promise.all` of 7 parallel `count(where: {enabled: true})` queries. Cache TTL 60s. If all counts are zero, the entire fan-out is skipped — saving 7+ Prisma round-trips per message.

Cache invalidation is wired into `BaseChatbotController.createBot/updateBot/deleteBot` so a freshly-enabled bot is picked up within the next event (not the 60s TTL).

For our deployment (zero chatbot integrations configured), this collapses 7+ queries-per-message to **1 cached check every 60s**.

### C. Auto-heal on persistent stall

`src/forensic/instance-tracker.ts` — when `stalledPipeline` (or `zombieSuspected`) is true continuously for `FORENSIC_AUTO_HEAL_AFTER_MS` (default 3 min), the heartbeat calls a registered `forceClose(reason)` hook that triggers `client.end(...)` on the Baileys socket. Baileys' built-in reconnect path then tears down the socket, mutex chain, and starts fresh.

Disabled by default. Enable with `FORENSIC_AUTO_HEAL=true`. Cooldown after firing: `FORENSIC_AUTO_HEAL_COOLDOWN_MS` (default 5 min).

The hook is registered in `whatsapp.baileys.service.ts` alongside `wsReadyState` so future channels can supply their own (Cloud API channel does not currently register one).

### D. Global fetch instrumentation

`src/utils/global-fetch-instrument.ts` — installed BEFORE any other module loads (in `main.ts`). Wraps `globalThis.fetch` to register every undici call into the in-flight registry with `{kind: 'fetch', url, method}`. Closes the visibility gap from Episode 1: the next time undici throws `terminated`, `dumpInFlight()` in the uncaughtException handler will tell us *which* URL was in flight, not just "node:internal/undici:13602".

Slow fetches (>30s, configurable via `FETCH_LOG_THRESHOLD_MS`) emit a `fetch.slow` forensic event.

### E. In-flight registry extended

`src/forensic/in-flight.ts` — `kind` now includes `'prisma'` and `'fetch'`; entries carry `{model, op, hint, stack}` for Prisma and `{url, hint(method)}` for fetch. `dumpInFlight()` now bounded by `FORENSIC_INFLIGHT_DUMP_MAX` (default 200, was 50). Added `inFlightStats()` for a compact rollup that's safe to embed in every forensic event.

## What still needs to happen on the operator side

1. **Coolify env update** (manual): set on `DATABASE_CONNECTION_URI`:
   ```
   postgresql://yRUgsn5PtxHSMPiV:...@postgres:5432/postgres?connection_limit=20&pool_timeout=10&statement_timeout=60000
   ```
   - `connection_limit=20` — more headroom under retry storms (default ~9 is too tight)
   - `pool_timeout=10` — Prisma waiters reject after 10s instead of hanging forever
   - `statement_timeout=60000` — Postgres-side hard cap; an in-flight query that runs >60s gets killed by the server, releasing the connection

2. **Postgres `idle_session_timeout`** (manual, on postgres container): so wedged `idle/ClientRead` connections die server-side after ~60s instead of sitting forever.
   ```
   ALTER SYSTEM SET idle_session_timeout = '60000';
   SELECT pg_reload_conf();
   ```

3. **Enable auto-heal** (Coolify env): `FORENSIC_AUTO_HEAL=true` once the new image has been live for 24h with clean heartbeats.

## How to verify the fix on the next deploy

```bash
# Confirm new code is live
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c PrismaTimeoutError /evolution/dist/api/repository/repository.service.js  # expect ≥ 1
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c installGlobalFetchInstrument /evolution/dist/main.js                     # expect ≥ 1
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c anyChatbotEnabled /evolution/dist/api/integrations/chatbot/chatbot.controller.js  # expect ≥ 1

# Watch for prisma.timeout events as a leading indicator
ssh root@157.90.233.12 "tail -f /data/coolify/figurinha-evolution/forensic/forensic.jsonl | jq -c 'select(.kind | startswith(\"prisma.\"))'"

# Confirm chatbot precheck is short-circuiting (should see at most 1 batch of 7 counts per 60s, not per message)
ssh root@157.90.233.12 "jq -c 'select(.kind == \"prisma.slow\" or .kind == \"prisma.timeout\")' /data/coolify/figurinha-evolution/forensic/forensic.jsonl | tail"
```

## What this taught us about the doc's existing taxonomy

The investigation document split zombies into 3 classes:

1. uncaughtException-class (patched by G4)
2. Baileys mutex deadlock (patched by v1+v2)
3. Auth-state pool exhaustion (patched by v3)

This incident is **Class 4: in-handler integration query fan-out + pool exhaustion**. The hang lives outside Baileys entirely. The mutex never sees it; auth-state never sees it; only a Prisma-wide timeout could have caught it.

The fix above closes class 4. There may be a class 5 (e.g., a third-party SDK that calls fetch and hangs) — the global fetch instrumentation will at least tell us where to look.

## Files

| Path | Change |
|---|---|
| `src/api/repository/repository.service.ts` | Read-op timeout wrapper; warn/error forensic forwarding |
| `src/api/integrations/chatbot/chatbot.controller.ts` | `anyChatbotEnabled` cache; `invalidateChatbotEnabledCache` export |
| `src/api/integrations/chatbot/base-chatbot.controller.ts` | Invalidation calls in createBot/updateBot/deleteBot |
| `src/forensic/instance-tracker.ts` | `stalledSinceMs`, `forceClose` hook, auto-heal in heartbeat |
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | Register `forceClose` callback with tracker |
| `src/forensic/in-flight.ts` | Extended kind enum + `inFlightStats()` rollup |
| `src/utils/global-fetch-instrument.ts` | New — wraps globalThis.fetch |
| `src/main.ts` | Install fetch instrument before any other import |
