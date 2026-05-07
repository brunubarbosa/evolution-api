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

- **Commit:** `fb4f4d6` deployed to prod 2026-05-03 21:31 UTC.
- **Production digest:** `ghcr.io/brunubarbosa/evolution-api@sha256:1e02bc5ac736290ce50e2ea703cedb937a25d6ddf1c687a33087b4be6ea16a1f`
- **Previous prod image (rollback target):** `atendai/evolution-api:v2.2.3`
  - To roll back: Coolify → service `gdg2okn1nxvpd1tybsjnbj50` → edit docker-compose, replace the `evolution-api` service `image:` line with `'atendai/evolution-api:v2.2.3'`, redeploy. Postgres/Redis volumes persist.
- **Verification:** `https://evolution-api.grupodewhatsapp.com/` returned `{status:200, version:"2.3.7"}`. Existing instance `test` reconnected without data loss.

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

## GDW-004 — group join-request action RPCs

- **Commit:** `<sha>` (2026-05-03)
- **Adds:** Six REST routes wrapping standard Baileys group RPCs that upstream Evolution does not expose:
  - `POST /group/acceptInviteV4/:instanceName` — `{ key, inviteMessage }` → `{ accepted, groupJid }`
  - `POST /group/revokeInviteV4/:instanceName?groupJid=…` — `{ invitedJid }` → `{ revoked, groupJid, invitedJid }`
  - `POST /group/updateMemberAddMode/:instanceName?groupJid=…` — `{ mode: 'admin_add' | 'all_member_add' }`
  - `POST /group/updateJoinApprovalMode/:instanceName?groupJid=…` — `{ mode: 'on' | 'off' }`
  - `GET  /group/pendingJoinRequests/:instanceName?groupJid=…` → `{ groupJid, pendingRequests }`
  - `POST /group/updatePendingJoinRequests/:instanceName?groupJid=…` — `{ participants: string[], action: 'approve' | 'reject' }`
- **Why upstream is wrong:** Baileys exposes `groupAcceptInviteV4`, `groupRevokeInviteV4`, `groupMemberAddMode`, `groupJoinApprovalMode`, `groupRequestParticipantsList`, and `groupRequestParticipantsUpdate` directly on the socket. Upstream Evolution registers no controller/route for any of them, so the only way to act on a captured `GROUP_JOIN_REQUEST` (GDW-002) was to bypass the API and patch baileys at runtime. Closes that loop.
- **Files touched:**
  - `src/api/dto/group.dto.ts` (5 new DTO classes)
  - `src/api/controllers/group.controller.ts` (6 new controller methods)
  - `src/api/routes/group.router.ts` (6 new routes)
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (6 new service methods + cache invalidation)
- **Worker dependency:** N/A — no worker consumer yet. Designed for the GDW admin UI (approve/reject pending join requests).
- **Rollback impact:** All six routes return 404. Existing GDW-002 capture continues to work but admins cannot act on captured requests via REST.
- **Detection on rollback:** Admin UI calls fail with 404 on the `/group/{acceptInviteV4,revokeInviteV4,updateMemberAddMode,updateJoinApprovalMode,pendingJoinRequests,updatePendingJoinRequests}` endpoints.
- **Upstream PR status:** `[upstream-pr-pending]` — clear gap, mirrors existing controller style.

## GDW-005 — widen `findGroup` / `findParticipants` response

- **Commit:** `<sha>` (2026-05-03)
- **Adds:** Pure-additive field passthrough on existing endpoints. Always-on, no env gate.
  - `GET /group/findGroupInfos/:instanceName?groupJid=…` now also returns: `addressingMode`, `ownerPn`, `owner_country_code`, `subjectOwnerPn`, `descOwner`, `descOwnerPn`, `descTime`, `memberAddMode`, `joinApprovalMode`, `ephemeralDuration`, `author`, `authorPn` (12 fields).
  - `GET /group/participants/:instanceName?groupJid=…` participants now include: `phoneNumber`, `lid` (2 fields).
- **Why upstream is wrong:** `findGroup()` and `findParticipants()` in `whatsapp.baileys.service.ts` build a literal object with a hand-picked subset of fields and silently drop the rest of what Baileys' `groupMetadata()` and `Contact` shapes return. The dropped fields include WA's dual-identity (LID/PN) markers — without them the GDW app cannot distinguish identity systems.
- **Files touched:**
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (additions to the `findGroup` and `findParticipants` return literals)
- **Worker dependency:** N/A — no worker consumer wired yet. Candidate for `apps/moderation-worker/src/groups/sync.ts` (richer group sync).
- **Rollback impact:** The 14 added fields drop out of responses. Any UI that reads them shows blank — does not break.
- **Detection on rollback:** UI shows missing owner/addressing-mode badges; integration tests asserting `addressingMode` presence fail.
- **Upstream PR status:** `[upstream-pr-pending]` — pure additive, no behavioral risk.

## GDW-006 — fix `GROUPS_UPDATE` event name

- **Commit:** `<sha>` (2026-05-03)
- **Adds:** `'GROUPS_UPDATE'` accepted as a subscribable event name in `EventController.events` registry. `'GROUP_UPDATE'` is retained for back-compat but is dead-code (the emit path uses `Events.GROUPS_UPDATE = 'groups.update'` which normalises to `GROUPS_UPDATE`, never matching the singular).
- **Why upstream is wrong:** `src/api/types/wa.types.ts` defines `Events.GROUPS_UPDATE = 'groups.update'`, but `src/api/integrations/event/event.controller.ts` only allows `'GROUP_UPDATE'` (singular) in its event allow-list. Result: the canonical event was un-subscribable; the only "valid" subscription name was a typo that never received events. Subscribers had no way to learn this without reading source.
- **Files touched:**
  - `src/api/integrations/event/event.controller.ts` (one-line addition)
- **Worker dependency:** N/A — no worker subscriber yet, but unblocks any future consumer of group metadata/subject changes.
- **Rollback impact:** `'GROUPS_UPDATE'` subscription requests get rejected by the event-controller validator; subscribers that switched to the canonical name silently stop receiving events.
- **Detection on rollback:** Worker integration tests subscribing to `GROUPS_UPDATE` fail validation; `events` table shows zero new `GROUPS_UPDATE` rows after a known group rename.
- **Upstream PR status:** `[upstream-pr-pending]` — one-line typo fix.

## GDW-007 — community REST surface

- **Commit:** `<sha>` (2026-05-03)
- **Adds:** 17 routes under `/community/*` mirroring Baileys' `communities.ts` 1:1.
  - `GET  /community/metadata/:instanceName?communityJid=…`
  - `POST /community/create/:instanceName` — `{ subject, body }`
  - `POST /community/createGroup/:instanceName` — `{ subject, participants, parentCommunityJid }`
  - `DELETE /community/leave/:instanceName?communityJid=…`
  - `POST /community/updateSubject/:instanceName?communityJid=…` — `{ subject }`
  - `POST /community/updateDescription/:instanceName?communityJid=…` — `{ description? }`
  - `POST /community/linkGroup/:instanceName` — `{ groupJid, parentCommunityJid }`
  - `POST /community/unlinkGroup/:instanceName` — `{ groupJid, parentCommunityJid }`
  - `GET  /community/linkedGroups/:instanceName?communityJid=…`
  - `GET  /community/inviteCode/:instanceName?communityJid=…` → `{ inviteUrl, inviteCode }`
  - `POST /community/revokeInvite/:instanceName?communityJid=…`
  - `GET  /community/acceptInvite/:instanceName?inviteCode=…`
  - `POST /community/acceptInviteV4/:instanceName` — `{ key, inviteMessage }`
  - `POST /community/revokeInviteV4/:instanceName?communityJid=…` — `{ invitedJid }`
  - `GET  /community/pendingRequests/:instanceName?communityJid=…`
  - `POST /community/updatePendingRequests/:instanceName?communityJid=…` — `{ participants, action }`
  - `POST /community/updateParticipants/:instanceName?communityJid=…` — `{ participants, action }`
- **Why upstream is wrong:** Baileys' `communities.ts` exposes the full community API (parent communities, linked subgroups, dual-V4 invites, pending-request workflow). Upstream Evolution exposes nothing under `/community/*` — communities are invisible to the REST consumer despite the underlying socket fully supporting them.
- **Files touched:**
  - `src/api/dto/community.dto.ts` (new file — 11 DTO classes)
  - `src/api/controllers/community.controller.ts` (new file — 17 methods, all pass-through)
  - `src/api/routes/community.router.ts` (new file — 17 routes)
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (17 new service methods + cache invalidation on mutations)
  - `src/api/routes/index.router.ts` (mount `/community`)
  - `src/api/server.module.ts` (register `communityController`)
- **Worker dependency:** N/A — no worker consumer wired. Candidate for community moderation features.
- **Rollback impact:** All 17 routes return 404. No persistence to clean up — patch is purely a REST surface over Baileys.
- **Detection on rollback:** Any UI / cron calling `/community/*` fails with 404.
- **Upstream PR status:** `[not-yet-pr-d]` — large surface, needs upstream interest assessment.

## GDW-008 — opt-in group-event audit log

- **Commit:** `<sha>` (2026-05-03)
- **Adds:**
  - New Prisma model `GroupEvent` (postgres + mysql schemas) with `instanceId`, `groupJid`, `eventType`, `action`, `method`, `actorJid`, `actorPn`, `affectedJid`, `affectedPn`, `payload` (JSON), `createdAt`. Three indexes (`(instanceId, groupJid, createdAt desc)`, `(instanceId, groupJid, eventType)`, `(createdAt desc)`).
  - New service `GroupEventPersistenceService` that records one row per affected participant on `group-participants.update` and one row per `group.join-request`. Hooked **after** existing webhook fan-out — never blocks delivery; all errors swallowed.
  - New env var `GDW_PERSIST_GROUP_EVENTS`. Default unset/`false` → persistence is a no-op (zero rows written, identical behaviour to GDW-007 image).
  - New endpoint `GET /group/events/:instanceName?groupJid=…&since=ISO&type=…&limit=N` (always registered; returns `[]` when persistence is off or no `prismaRepository` is wired). `limit` defaults to 100, capped at 500. `groupJid` is required and auto-suffixed with `@g.us`.
- **Why upstream is wrong:** Upstream Evolution stores **nothing** when a webhook delivery fails — a network blip / consumer-down / signature mismatch loses the underlying group event forever. There is no replay path. This patch gives the consumer a queryable audit trail decoupled from webhook delivery success.
- **Files touched:**
  - `prisma/postgresql-schema.prisma`, `prisma/mysql-schema.prisma` (new `GroupEvent` model + relation on `Instance`)
  - `src/api/services/group-event-persistence.service.ts` (new file)
  - `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` (instantiate service in ctor; record after `GROUP_PARTICIPANTS_UPDATE` and `GROUP_JOIN_REQUEST` fan-out)
  - `src/api/dto/group.dto.ts` (`GroupEventsQueryDto`)
  - `src/api/controllers/group.controller.ts` (constructor takes optional `PrismaRepository`; `findGroupEvents` method)
  - `src/api/routes/group.router.ts` (`GET /group/events` route)
  - `src/api/server.module.ts` (pass `prismaRepository` into `GroupController`)
- **Worker dependency:** N/A — no worker consumer wired. Candidate for `apps/moderation-worker/` webhook-miss recovery (replay missing events from the audit table).
- **Rollback impact:**
  - With `GDW_PERSIST_GROUP_EVENTS=false` (default): zero impact — no rows written, no consumers affected.
  - With persistence enabled: `GET /group/events` returns 404; new rows stop accumulating; existing rows orphaned (table can stay; no FK from outside).
- **Detection on rollback:** `GroupEvent` row insert rate drops to zero on instances with active group activity; consumer GET requests 404.
- **Upstream PR status:** `[not-yet-pr-d]` — design is opinionated (Prisma row-per-participant); needs upstream interest assessment.

**Deferred follow-up — GDW-008b:** Stub-type ingestion (persisting raw `messages.upsert` stub messages such as `GROUP_PARTICIPANT_ADD` (27), `GROUP_SUBJECT` (24), `GROUP_PICTURE` (25), `GROUP_DESCRIPTION` (26) with `eventType: 'stub:<NUM>'`) was deferred. The schema already accommodates these (`eventType` is a free string), so GDW-008b will only add the message-handler hook — no migration needed.

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
