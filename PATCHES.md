# GDW Patch Registry

This file lists every patch on top of upstream `EvolutionAPI/evolution-api` that lives on the `vendor/gdw` branch. Each entry is the contract between this fork and the consumer projects (primarily `grupodewhatsapp/apps/moderation-worker`).

If you are adding a new patch, copy the template at the bottom. If you are reviewing this fork, every `// [GDW]` marker in the code corresponds to an entry here.

The full playbook for adding patches lives at `grupodewhatsapp/docs/evolution-fork/PLAYBOOK.md`.

---

## GDW-001 — preserve `author` / `authorPn` on `group-participants.update`

- **Commit:** `6dbc27c` (2026-05-03)
- **Adds:** `author`, `authorPn`, `authorData` fields on the `GROUP_PARTICIPANTS_UPDATE` webhook payload.
- **Why upstream is wrong:** The handler signature in `whatsapp.baileys.service.ts` types the payload as `{ id, participants, action }` and silently drops `author` and `authorPn` from the underlying Baileys `<notification participant="…" participant_pn="…">` stanza. Without these, "who added whom" is unanswerable.
- **Files touched:**
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (handler signature + body)
- **Worker dependency:** `grupodewhatsapp/apps/moderation-worker/src/server/webhook.ts` reads `data.author` for `actor_jid` on `stats.participant_events`.
- **Rollback impact:** `stats.participant_events.actor_jid` reverts to NULL on new rows. Worker handles missing field gracefully.
- **Detection on rollback:** Alert on `actor_jid IS NULL` rate climbing back toward 100% on `stats.participant_events`.
- **Upstream PR status:** `[upstream-pr-pending]` — clear bug, should be PR'd.

## GDW-002 — wire up `group.join-request` event

- **Commit:** `9d63368` (2026-05-03)
- **Adds:** New webhook event `GROUP_JOIN_REQUEST` carrying `{ id, author, participant, action, method }`.
- **Why upstream is wrong:** Baileys emits `group.join-request` (created/revoked/rejected, with `method` ∈ `invite_link` | `non_admin_add`). Upstream Evolution registers no listener and the event is silently dropped.
- **Files touched:**
  - `src/api/types/wa.types.ts` — `GROUP_JOIN_REQUEST` enum entry
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` — handler + dispatch loop
  - `src/validate/instance.schema.ts` — added to all 4 transport enums
  - `src/api/integrations/event/event.controller.ts` — added to master event list
- **Worker dependency:** `grupodewhatsapp/apps/moderation-worker/src/server/webhook.ts` `GROUP_JOIN_REQUEST` case → `stats.join_requests` table.
- **Skipped:** the global env.config.ts gates (`RABBITMQ_EVENTS_*`, `WEBSOCKET_EVENTS_*`, etc.) — those control global-broadcast routing, which we don't use. Per-instance webhooks read from `event.controller.ts`.
- **Rollback impact:** `stats.join_requests` table stops receiving inserts. Existing rows untouched.
- **Detection on rollback:** Alert on `stats.join_requests` insert rate dropping to zero for >1h on instances with active managed groups.
- **Upstream PR status:** `[not-yet-pr-d]` — needs upstream interest assessment.

## GDW-003 — fork hardening retrofit (operational)

- **Commit:** *(this branch HEAD — see git log)*
- **Adds:** Operational scaffolding required before scaling to more patches.
  - Branch rename `feat/gdw` → `vendor/gdw`
  - CI workflow hardening (SHA-pinned actions, lockfile check, smoke test, Trivy scan, cosign signing, SBOM)
  - New tag scheme `gdw-<upstream>-<sha>` (pinned) + `vendor-gdw-latest` (floating, dev only)
  - This `PATCHES.md` registry
  - `docs/UPSTREAM_SYNC.md` runbook
  - Marker normalization: every patch hunk now uses `// [GDW]`
- **Why upstream is wrong:** N/A — this is downstream-only operational work, not a code-behavior patch.
- **Files touched:**
  - `.github/workflows/publish_ghcr_fork.yml`
  - `PATCHES.md` (new)
  - `docs/UPSTREAM_SYNC.md` (new)
  - `scripts/list-fork-patches.sh` (new)
  - In-code marker comments across the patched files
- **Worker dependency:** none directly; consumed corollaries (Zod schemas, dedup fix, DLQ, observability) live in `grupodewhatsapp/apps/moderation-worker` under the same GDW-003 PR.
- **Rollback impact:** Reverts CI to old workflow; image tag scheme reverts. No runtime impact on the deployed image.
- **Upstream PR status:** N/A.

---

## Template for new patches

```markdown
## GDW-NNN — <one-line summary>

- **Commit:** `<sha>` (YYYY-MM-DD)
- **Adds:** what new field / event / behavior the worker (or other consumer) gains.
- **Why upstream is wrong:** point to the upstream code path that drops this. Quote the type/handler if helpful.
- **Files touched:**
  - relative paths within this fork
- **Worker dependency:** which file in `grupodewhatsapp/apps/moderation-worker/` reads this.
- **Rollback impact:** what stops working if Coolify is reverted to the previous image.
- **Detection on rollback:** which alert / metric notices.
- **Upstream PR status:** `[upstream-pr-pending|upstream-merged|not-applicable|not-yet-pr-d]`
```

---

## Auditing the patch surface

```bash
git grep -n "\[GDW\]"
# or
./scripts/list-fork-patches.sh
```

Every `// [GDW]` comment must reference a patch ID in this file.
