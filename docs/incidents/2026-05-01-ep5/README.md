# 2026-05-01 — Zombie Episode 5: Postgres idle_session_timeout amplifier + snapshot blind-spots

**Status:** Patched. Bot was zombie from **18:59:27 UTC to ~22:30 UTC (~3h30m)**. Recovery via image redeploy at 22:30; the new image carries v3.1 forensic improvements + the Postgres `idle_session_timeout` was disabled at the same time. Auto-heal still disabled by env flag (24h baseline first).

## What happened (timeline UTC)

| Time | Event |
|---|---|
| 16:02:42 | process.boot pid=198 (current process starts after a previous restart) |
| 16:18 → 18:39 | **24 mutex timeouts in pairs** (12 pairs, ~hourly) — patches v1+v2 firing as designed; bot kept ticking between fires |
| 18:58:02 | First Prisma `FATAL` `idle-session timeout` (SQLSTATE E57P05) errors — Postgres killing idle pool sockets after 60s |
| **18:59:27.749** | `process.uncaughtException: TypeError: terminated` from `undici Fetch.onAborted` — IDENTICAL stack to ep1 (2026-04-30) and ep4 (2026-05-01 morning) |
| 18:59:27 → 19:27 | 28 minutes of complete silence: no webhooks, no events, no ws messages |
| 19:00:04 → 19:00:27 | 9 more Prisma E57P05 errors |
| 19:27:52.989 | `event.ws.close` code 1006 — TCP abnormal close, no protocol close frame |
| 19:27 → 22:30 | **No ws.open. No connection.update. No reconnect attempted.** Process alive but bot dead. Detector fired `zombie.suspected` 218 times (~every minute) |
| 22:11 | Operator (Bruno) ran `ALTER SYSTEM SET idle_session_timeout = 0` + `pg_reload_conf()` |
| 22:30 | New image deployed (`7cb09d4`); bot reconnected; 124 webhooks in next 5min |

## Root cause

**Postgres `idle_session_timeout = 60000` was the underlying amplifier for every prior zombie class.**

The figurinha-evolution Postgres had `ALTER SYSTEM SET idle_session_timeout = '60000'` set in `postgresql.auto.conf` (origin unknown — likely set during a prior unrelated debugging session, or as a misguided defensive measure). Postgres killed every connection that had been idle ≥60s with `FATAL: terminating connection due to idle-session timeout` (SQLSTATE E57P05).

Prisma's connection pool (`connection_limit=20`, `pool_timeout=10`) didn't know the connections were dead. Next checkout from pool returned a dead socket. Query awaited the response forever. Symptoms cascaded through every prior layer:

1. Hung Prisma query → Baileys mutex deadlock (caught by mutex patch but leaked promise)
2. Hung Prisma query → auth-state I/O timeout fired (caught by v3 wrapper, but next attempt hung again)
3. Hung Prisma query → chatbot fan-out wedged (caught by v4 wrapper, but pool stayed sick)
4. Hung Prisma query → undici fetch sharing event-loop microtasks → `TypeError: terminated` from undici when its TLS socket closed under it
5. **Unhandled exception inside Baileys' WS-event path → reconnect handler never ran** ← this is the new failure mode in ep5; ep1/ep4 did eventually reconnect

The previous fixes were all correct but treated symptoms. **Disabling `idle_session_timeout` removes the trigger.**

### Why the WS reconnect didn't fire (the new failure mode)

Forensic shows zero `connection.update({connection: 'close'})` events between 18:59:27 and 22:30. The `event.ws.close` code 1006 fired at 19:27:52 (28 minutes after the uncaughtException), but Baileys' standard `ws.on('close')` → `connectionUpdate({ connection: 'close' })` → reconnect path never executed. Hypothesis: the uncaughtException at 18:59 left the WS event-loop in inconsistent state; Baileys' subscriber to the WS close event was either unregistered or its callback rejected silently. **Auto-heal (when enabled) covers this case**: after 3min of `zombieSuspected`, heartbeat calls `client.ws.close(1000, 'autoheal')` directly, bypassing Baileys' state machine.

## What we shipped

### A. Postgres setting fix (operator)

```sql
ALTER SYSTEM SET idle_session_timeout = 0;
SELECT pg_reload_conf();
```

Verified live: `pg_settings.setting='0'`, `source='configuration file'`. Persisted in `/var/lib/postgresql/data/postgresql.auto.conf`.

### B. Forensic v3.1 — snapshot blind-spots closed (`7cb09d4`)

The 2026-05-01 forensic JSONL had everything we needed to diagnose ep5 in real-time, but it required SSHing in and grepping ~9MB of JSONL. The `/forensic/snapshot` endpoint showed point-in-time state only.

**Sliding-window error counters** in every snapshot, per-instance:
- `mutexTimeouts {last5m, last1h, lastError}`
- `prismaTimeouts {last5m, last1h, lastError}`
- `fetchErrors {last5m, last1h, lastError}`
- `authStateTimeouts {last5m, last1h, lastError}`

Wired via a new `subscribeForensic(fn)` pub/sub on `forensic-logger.ts`. The `instance-tracker.ts` subscribes once at module load and routes every `forensic({kind:...})` event into the right per-instance bucket. Cross-cutting concerns (Prisma, fetch, auth-state) feed the snapshot without threading explicit code paths.

**`connection.update` flood dedup**: the steady-state pulse fires `{connection: null, statusCode: null, errorMessage: null, hasQr: false}` dozens of times per second. We saw 100+ such empty events in the 2026-05-01 trail, drowning the meaningful transitions. `recordActivity` now skips the JSONL line when the new payload signature matches the previous AND it's the all-null pulse.

**`ZOMBIE_GAP_MS` default**: 600s → 180s (was the documented 9m59s false-negative).

**`uncaughtException` dump** now includes `ringTail` of last 100 in-memory forensic events. Self-contained even if disk JSONL has rotated (10MB×3 = ~10min retention under verbose pino debug).

**`fetch.error` event** now emitted by `global-fetch-instrument.ts` (previously only `fetch.slow`). Carries `{url, host, durationMs, message, code, causeMessage, causeCode}`. Closes the visibility gap — the next undici `terminated` will name its URL.

**Snapshot `thresholds`** field now exposes `{zombieGapMs, autoHealEnabled, autoHealAfterMs, autoHealCooldownMs, heartbeatMs}` so an operator looking at a stale snapshot can see what it WAS configured to detect.

### C. Local clone refresh runbook

The fork is at `github.com/brunubarbosa/evolution-api` remote name `fork`. The user works on branch `main`. Two commits I missed before reading the existing tree (`82e9d00` + `43fad1b`) were on local `main` but not pushed — pushed during ep5 along with `7cb09d4`. Always run `git log fork/main..main --oneline` before starting work.

## What still needs to happen

### Operator (24h after 2026-05-01 22:30 UTC, i.e. by **2026-05-02 22:30 UTC**)

If 24h baseline is clean (all 4 buckets zero, no zombie events): set `FORENSIC_AUTO_HEAL=true` in Coolify env on service `yxrk4h8hy4tg5vpeaj11qx47` and recreate the api container. After enable, the heartbeat will call `client.ws.close(1000, 'autoheal:...')` automatically when a stall persists 3min.

### If a new class of zombie surfaces

The snapshot now shows the bucket that fired. Diagnose from the `lastError.message` in that bucket. Don't restart blindly — the bucket counters are the diagnostic. Add the new pattern to `docs/zombie-instance-investigation.md` TL;DR list as class 6.

### Upstream

Baileys v7.0.0 stable: when it ships, delete `patches/baileys+7.0.0-rc.9.patch` and the `postinstall` hook. PR #2151 will already be in.

## How to verify the fix on the next deploy

```bash
# Confirm new code is live
ssh root@157.90.233.12 '
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c PrismaTimeoutError /evolution/dist/api/repository/repository.service.js
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c FETCH_LOG_THRESHOLD_MS /evolution/dist/utils/global-fetch-instrument.js
docker exec api-yxrk4h8hy4tg5vpeaj11qx47 grep -c last5m /evolution/dist/forensic/instance-tracker.mjs
'

# Snapshot now shows new bucket fields
curl -s "$EVOLUTION_API_URL/forensic/snapshot" -H "apikey: $EVOLUTION_API_KEY" \
  | jq '.instances[] | {name, mutexTimeouts, prismaTimeouts, fetchErrors, authStateTimeouts, zombieSuspected, autoHealCount}'

# Postgres setting persisted
ssh root@157.90.233.12 'docker exec postgres-yxrk4h8hy4tg5vpeaj11qx47 \
  psql -U yRUgsn5PtxHSMPiV -d postgres -tAc \
  "SELECT name, setting, source FROM pg_settings WHERE name='\''idle_session_timeout'\''"'
# Expect: idle_session_timeout|0|configuration file
```

## Files

| Path | Change |
|---|---|
| `src/forensic/forensic-logger.ts` | `subscribeForensic()` observer pub/sub; `notifyObservers` in both async + sync paths |
| `src/forensic/instance-tracker.ts` | bucket counters (`emptyBucket`/`bumpBucket`/`bucketSummary`), ring buffer (200), snapshot enrichment, dedup logic, `ZOMBIE_GAP_MS` default 180s, observer wiring at module bottom |
| `src/config/error.config.ts` | `ringTail(100)` included in uncaughtException dump |
| `src/utils/global-fetch-instrument.ts` | `fetch.error` emission with `{url, host, durationMs, message, code, causeMessage, causeCode}` |
| **postgresql.auto.conf** (VPS, runtime) | `idle_session_timeout = '0'` |

## What this taught us about the doc's existing taxonomy

The investigation document listed 4 classes; ep5 adds class 5 — but more importantly it reframes them: **classes 1–4 were all symptoms of the Postgres timeout amplifier**. Class 1 (uncaughtException) was triggered by undici aborting on a TLS socket killed by Postgres reaping its peer. Classes 2/3/4 were variants of the same dead-pool-socket cascade. Disabling `idle_session_timeout` should drop ALL classes 1–4 to near-zero rate. If they recur post-fix, the in-tree patches (mutex/auth-state/Prisma timeout/chatbot cache/auto-heal) catch each at its own layer.
