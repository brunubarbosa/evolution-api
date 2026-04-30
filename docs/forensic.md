# Forensic instrumentation

Goal: when an Evolution instance silently goes dead (socket alive in DB,
zero events flowing), leave enough breadcrumbs on disk to answer
**"what was the last thing the socket did before it stopped?"** without
having to guess from absence of logs.

## What gets captured

All output is JSONL (one event per line) under `FORENSIC_LOG_DIR`
(default `/evolution/forensic`). Three files:

- `forensic.jsonl` — append-only event stream. Rotates at 10 MB, keeps 5.
- `forensic.{1..5}.jsonl` — rotated history.
- `state-snapshot.json` — overwritten every heartbeat (60 s by default)
  with the current per-instance state. This is the
  last-will-and-testament if the process dies.

Event kinds emitted today:

| kind                       | when                                                                |
|----------------------------|---------------------------------------------------------------------|
| `process.boot`             | server has started listening                                        |
| `process.uncaughtException` / `process.unhandledRejection` | uncaught error at the process level |
| `process.signal`           | SIGTERM/SIGINT/SIGQUIT/SIGHUP received                              |
| `process.beforeExit` / `process.exit` | event loop emptied / final exit                          |
| `instance.register`        | Baileys/Cloud instance attached to the tracker                      |
| `event.connection.update`  | every Baileys connection state transition (open/close/connecting)   |
| `event.ws.open`            | underlying WebSocket opened                                         |
| `event.ws.close`           | WebSocket closed (with WS code + reason buffer)                     |
| `event.ws.error`           | WebSocket emitted error                                             |
| `webhook.delivery`         | every outbound webhook attempt — ok/fail, status, latency, error    |
| `heartbeat`                | periodic snapshot — see structure below                             |
| `zombie.suspected`         | DB says `open` but no activity in `FORENSIC_ZOMBIE_GAP_MS`          |

Routine high-volume events (`messages.upsert`, `ws.message`,
`presence.update`, etc.) are **not** logged per occurrence — they only
bump the in-memory `lastActivityAt` and counters that show up in the
heartbeat. This is what lets us answer "when did the socket stop being
chatty?" without flooding the file.

## Heartbeat shape (per instance)

```json
{
  "name": "figurinha-bot-02",
  "channel": "baileys",
  "dbStatus": "open",
  "wsReadyState": 1,
  "uptimeSec": 93420,
  "lastActivityKind": "ws.message",
  "msSinceLastActivity": 421,
  "msSinceLastConnectionUpdate": 91234120,
  "msSinceLastWsClose": null,
  "msSinceLastWebhookDelivery": 421,
  "activityCounts": { "ws.message": 18342, "messages.upsert": 412, ... },
  "lastWsClose": null,
  "lastWsError": null,
  "lastWebhookFailure": null,
  "zombieSuspected": false
}
```

`wsReadyState` follows the standard WebSocket constants: `0=connecting`,
`1=open`, `2=closing`, `3=closed`. If the DB column says `open` but
`wsReadyState !== 1` and there's been no activity for
`FORENSIC_ZOMBIE_GAP_MS`, `zombieSuspected: true` is set and a
dedicated `zombie.suspected` line is appended to `forensic.jsonl`.

## Live inspection

`GET /forensic/snapshot` (apikey-auth, same as every other admin route)
returns the same payload the heartbeat writes to disk. Useful when you
suspect an instance is misbehaving and want a one-shot read without SSH.

```
curl -sS https://<host>/forensic/snapshot -H "apikey: $KEY" | jq .
```

## After a silent disruption — diagnosis recipe

1. Pull the snapshot and the last few heartbeat lines:
   ```bash
   cat /evolution/forensic/state-snapshot.json | jq .
   tail -n 20 /evolution/forensic/forensic.jsonl | jq 'select(.kind=="heartbeat")'
   ```
2. Find the moment activity stopped:
   ```bash
   jq 'select(.kind=="heartbeat") | .summary.instances[] |
        select(.name=="figurinha-bot-02") |
        {ts:input_filename, msSinceLastActivity, wsReadyState, dbStatus}' \
     /evolution/forensic/forensic.jsonl | tail -n 50
   ```
3. Did the WS ever say `close` or `error`? Did `connection.update` ever
   fire? Either is the smoking gun:
   ```bash
   jq 'select(.kind|test("ws\\.(close|error)|connection\\.update"))' \
     /evolution/forensic/forensic.jsonl
   ```
4. Did webhook deliveries fail at the same time?
   ```bash
   jq 'select(.kind=="webhook.delivery" and .ok==false)' \
     /evolution/forensic/forensic.jsonl
   ```
5. Did the process die? Check for `process.signal`,
   `process.uncaughtException`, `process.exit`.

## Tuning

| env var                      | default              | what                                  |
|------------------------------|----------------------|---------------------------------------|
| `FORENSIC_LOG_DIR`           | `/evolution/forensic`| where the files go                    |
| `FORENSIC_ROTATE_BYTES`      | `10485760` (10 MB)   | rotate threshold                      |
| `FORENSIC_KEEP_FILES`        | `5`                  | rotated files retained                |
| `FORENSIC_HEARTBEAT_MS`      | `60000`              | snapshot interval                     |
| `FORENSIC_ZOMBIE_GAP_MS`     | `600000` (10 min)    | activity gap that flags `zombieSuspected` |

## Coolify setup

1. Mount a host directory at `/evolution/forensic` (e.g.
   `/data/coolify/figurinha-evolution/forensic`).
2. The Dockerfile already declares `VOLUME /evolution/forensic` and
   sets `FORENSIC_LOG_DIR=/evolution/forensic`.
3. After a deploy, verify:
   ```bash
   ssh root@<host> 'ls -lh /data/coolify/figurinha-evolution/forensic/'
   ssh root@<host> 'tail /data/coolify/figurinha-evolution/forensic/forensic.jsonl'
   ```
