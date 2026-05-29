# Baileys Upgrade Plan: rc10 → rc13

**Scope (decided 2026-05-29):** Bump **Baileys only**, `7.0.0-rc10 → 7.0.0-rc13`. **Stay on Evolution base 2.3.7** (`cd800f2`). Keep the outbound tracer.

This is deliberately **not** an Evolution upstream bump. See "Why not bump Evolution" below.

---

## TL;DR — what we found and why this shape

| Finding | Evidence | Consequence |
|---|---|---|
| Evolution & Baileys versions are **decoupled** | Upstream Evolution 2.3.7, 2.4.0-rc1, rc2, and `develop` HEAD **all pin `baileys@7.0.0-rc.9`**. We're already on rc10. | "Go latest Evolution to get newer Baileys" is false. Bumping Baileys is our independent decision. |
| Our rc10 has a **Critical CVE** | CVE-2026-48063 / GHSA-qvv5-jq5g-4cgg (message spoofing + app-state corruption via `placeholderResendMessage`). Fixed in **rc12** / 6.7.22. | Primary motivation. Security-driven. |
| The CVE fix doesn't touch our patches | Fix is in `src/Utils/process-message.ts` (`3beb08e`). | No conflict with our patch surface. |
| **All 3 patched Baileys files are byte-untouched rc10→rc13** | `git log v7.0.0-rc10..v7.0.0-rc13 -- src/Socket/messages-send.ts src/Utils/link-preview.ts src/Types/Message.ts` → **0 commits each**. | The patch re-applies cleanly. Low risk. |
| Baileys packaging unchanged | rc13 `package.json` still `"main": "lib/index.js"`, still compiles to `lib/`, still ESM. | Our `patch-package` paths (`lib/Socket/messages-send.js`, `lib/Utils/link-preview.js`, `lib/Types/Message.d.ts`) are still valid. |
| `patch-package` matches by **exact version** | File must be `baileys+<installed-version>.patch`. | **Must rename** `baileys+7.0.0-rc10.patch` → `baileys+7.0.0-rc13.patch` or it **silently no-ops** (2026-05-13-class trap). |
| rc13 is on npm | `npm view baileys@7.0.0-rc13` resolves. rc11/rc12/rc13 all published. | Plain `package.json` pin works; no git dep. |

**Target: `7.0.0-rc13`** (2026-05-21, latest v7 pre-release). It rolls up:
- **rc11** — libsignal moved git→npm (removes git-at-install requirement), `whatsapp-rust-bridge@0.5.4` non-SIMD support, group online count in presence.
- **rc12** — 🔒 the Critical CVE fix + undici fetch-dispatcher guard.
- **rc13** — peer-routed self-stanza `fromMe` fix + `Long` type import fix.

None of rc11/12/13's changes touch our three patched files.

---

## Why NOT bump Evolution (the rejected alternative)

Moving the fork's base from 2.3.7 → 2.4.0/`develop` was considered and rejected:
- **Mandatory license activation (BREAKING #2530).** 2.4.0 gates every instance behind activation against the Evolution Foundation licensing server — endpoints return **503 until activated**. Would require either staying pre-2.4.0 or carrying a neutralizing patch / `EVOLUTION_OPERATOR_EMAIL` headless path. License also changed to Apache-2.0.
- **2,752 commits** between our base and `develop`, **124 touching Prisma** (needs a migration reconciliation pass), with heavy churn in `whatsapp.baileys.service.ts` — *the* file our fork patches most.
- **Zero Baileys benefit** — develop still pins rc.9, behind us.

If we ever do want 2.4.0's features (Kafka, carousel/PIX interactive messages, SOCKS proxy), that's a separate, larger project tracked on its own. This plan does not touch it.

---

## The patch surface we must preserve

Two layers. **Both** must survive the bump.

### Layer 1 — `patch-package` file (the only thing the bump directly endangers)
`patches/baileys+7.0.0-rc10.patch` bundles **4 independent concerns** across 3 compiled files:

| Concern | File / hunk | Consumed? |
|---|---|---|
| Outbound tracer L4 (`emitGdwTrace` + `relayMessage` traceId) | `Socket/messages-send.js` + `Types/Message.d.ts` | **Yes** (KEEP — per decision) |
| Empty-bubble SKDM defense (strip `conversation:''` before spread) | `Socket/messages-send.js` | **Yes** — real protocol bug fix |
| viewOnce unwrap in `getMediaType` | `Socket/messages-send.js` | **Yes** — Instagram-stories feature |
| Link-preview UA injection + broken-image guard | `Utils/link-preview.js` | **Yes** — affiliate/marketplace previews |

### Layer 2 — Evolution source patches (NOT touched by a Baileys-only bump, but must keep compiling/working against rc13's runtime)
Actively consumed by the moderation-worker (must keep working):
- **GDW-001** author/authorPn on `GROUP_PARTICIPANTS_UPDATE` → `stats.participant_events.actor_*`
- **GDW-002** `GROUP_JOIN_REQUEST` event → `stats.join_requests`
- **GDW-005 (subset)** `addressingMode`, `owner`, `phoneNumber`, `ephemeralDuration`, `joinApprovalMode`, `memberAddMode`
- **GDW-006** `GROUPS_UPDATE` deliverable → `stats.group_setting_changes`
- **GDW-004** only `POST /group/updatePendingJoinRequests` (approve/reject)
- **send-media** `viewOnce` + `gifPlayback`; **send-text** custom `linkPreview` object
- **outbound-trace** L1 + `X-GDW-Trace-Id` header contract

Runtime-coupled-but-not-consumed-externally (highest Baileys-internal coupling, watch in smoke test): the **forensic/zombie-autoheal subsystem** (`src/forensic/instance-tracker.ts` + the autoheal block in `whatsapp.baileys.service.ts`) reaches into `client.ev.process`, `client.ws.readyState`, `client.end()`, `signalRepository.lidMapping`. None of these Baileys internals changed rc10→rc13, but this is where a regression would hide if one existed.

Unused / safe to ignore for this bump: GDW-007 `/community/*`, GDW-008 audit log, 5 of 6 GDW-004 routes, GDW-005 identity-extras, posthog-router/forensic output.

---

## Procedure

### Phase 0 — Branch & baseline (safety)
1. `cd whatsapp/evolution-api`, confirm clean tree on `vendor/gdw`.
2. Create work branch: `git checkout -b chore/baileys-rc13 vendor/gdw`.
3. Capture current prod digest for rollback (already in PATCHES.md GDW-003; re-confirm Coolify service `gdg2okn1nxvpd1tybsjnbj50` current image).
4. Baseline the patch applies today: `rm -rf node_modules && npm ci` → confirm `patch-package` reports the rc10 patch applied with no errors.

### Phase 1 — Bump the pin
5. `package.json`: `"baileys": "7.0.0-rc10"` → `"7.0.0-rc13"`.
6. `npm install baileys@7.0.0-rc13` to refresh `package-lock.json` (regenerates the resolved tarball + integrity + transitive deps — note libsignal moves git→npm, so the lockfile's `libsignal` entry will change from `git+https://…` to a registry version; that's expected and desirable).
7. **Expect `patch-package` to fail at this step** — the file is still named `…rc10.patch` and won't match `rc13`. That's the signal to regenerate.

### Phase 2 — Regenerate the patch against rc13 (the core of the work)
The rc10 patch's `index <sha>..<sha>` lines and context are tied to rc10's compiled output. Even though source is unchanged, regenerate cleanly so patch-package's checksum matches rc13's `lib/`.

8. Rename intent: the final file will be `patches/baileys+7.0.0-rc13.patch`.
9. **Re-derive the 4 concerns onto rc13's `node_modules/baileys/lib/`:**
   - `npm install baileys@7.0.0-rc13` (no patch yet — temporarily move the rc10 patch aside).
   - Hand-apply each of the 4 hunks to the fresh rc13 `lib/Socket/messages-send.js`, `lib/Utils/link-preview.js`, `lib/Types/Message.d.ts`. Because the source is byte-identical rc10→rc13, the hunks should drop in at the same logical locations; verify each `// [GDW]` block lands in the right function (`emitGdwTrace`/`relayMessage`/`getMediaType`/`getUrlInfo`).
   - `npx patch-package baileys` → produces `patches/baileys+7.0.0-rc13.patch`.
10. `git rm patches/baileys+7.0.0-rc10.patch` (the old one). Leave `patches/_archive/*.obsolete` alone.
11. Re-run `rm -rf node_modules && npm ci` from scratch → confirm patch-package applies the **rc13** patch with zero rejected hunks.
12. **Diff-audit the regenerated patch** against the old one: `git diff` the two patch files' *content hunks* (ignoring `index`/version-string lines) must be semantically identical — same 4 concerns, same `// [GDW]` comments. This is the gate that proves no behavior changed.

### Phase 3 — Build & local smoke
13. `npm run build` (tsc) → must pass. The Evolution-side patches reference Baileys types (`MinimalRelayOptions.traceId`, viewOnce envelope, WAUrlInfo); a type regression surfaces here.
14. Docker smoke per `docs/UPSTREAM_SYNC.md` (boot throwaway, `curl /` → 200, version 2.3.7).
15. **Full local functional smoke** using the `evolution-troubleshoot` skill against the local stack:
    - Connect a test instance (QR) — confirms the **autoheal/forensic** subsystem boots clean against rc13's socket object (the highest-coupling code).
    - Send a **viewOnce** media → confirm WA accepts (the `getMediaType` patch).
    - Send a **text with custom linkPreview object** → confirm card renders.
    - Send a **gifPlayback** video.
    - Trigger a **group participants change** + **join request** → confirm `author`/`authorPn` and the `GROUP_JOIN_REQUEST` webhook reach the worker (`stats.participant_events`, `stats.join_requests`).
    - Tail `outbound:trace` via `scripts/trace-outbound.ts` → confirm L4.relay breadcrumbs still emit (proves the tracer hunk survived).

### Phase 4 — Docs & registry hygiene (fixes the stale PATCHES.md)
16. Update `PATCHES.md`: add the missing GDW-009+ entries (proxy-pool, send-media viewOnce, send-media gifPlayback, send-text WAUrlInfo, link-preview server patch, outbound-tracer, empty-bubble/getMessage, reconnect-classifier, forensic/autoheal, posthog-router) and resolve the GDW-006/007 marker collision. At minimum, note the Baileys patch is now `…rc13.patch` and re-state the 4 concerns it bundles.
17. Update `docs/UPSTREAM_SYNC.md` with a short "Baileys-only bump" subsection pointing at this procedure (the existing runbook only covers Evolution rebase, not a Baileys version bump + patch re-roll).
18. `.env.example` / `env.example`: no change (no new env). Confirm `OUTBOUND_TRACE_REDIS_URL` doc stays accurate.

### Phase 5 — Ship (follows the existing CI/Coolify path; respects the redeploy rules)
19. Commit: `chore(deps): bump baileys 7.0.0-rc10 → 7.0.0-rc13 (CVE-2026-48063); re-roll patch`.
20. Push branch → open PR on the fork → CI runs smoke + Trivy + cosign + GHCR publish (per `publish_ghcr_fork.yml`).
21. Merge to the branch that publishes the prod tag; note the new GHCR digest in PATCHES.md GDW-003 as the new rollback-forward target.
22. **Deploy via the worker/Evolution path on VPS B** (Coolify service `gdg2okn1nxvpd1tybsjnbj50`, server `91.98.196.152`). The worker is stateless and not user-facing, so `force_rebuild: true` is acceptable here (unlike the GDW frontend). Still: pre-check the Coolify deploy queue for stale rows first.
23. **Post-deploy verification** (per UPSTREAM_SYNC.md + our consumption map):
    - `docker logs <evolution> | grep -i error` — clean boot.
    - Existing instance reconnects without re-pairing (auth state intact).
    - One synthetic `GROUP_PARTICIPANTS_UPDATE` → `actor_jid` populated.
    - One synthetic invite-link join → row in `stats.join_requests`.
    - Watch worker `[webhook]` logs 30 min.
    - Confirm `outbound:trace` still receiving L4 events.

---

## Rollback
Single-image rollback (rc10 is still on npm and the rc10 patch is in git history):
- Coolify: revert service `gdg2okn1nxvpd1tybsjnbj50` to the previous GHCR digest (the current prod digest in PATCHES.md GDW-003). Postgres/Redis volumes persist; instances reconnect.
- Or git-revert the bump commit and let CI republish.

## Risk assessment
- **Low overall.** The three patched Baileys files are unchanged across the bump; packaging is unchanged; rc13 is on npm; the change is a version pin + a re-rolled patch.
- **Single biggest trap:** forgetting to rename the patch file → patch-package silently ships **unpatched** Baileys (no tracer L4, viewOnce media dropped, link previews fail, empty-bubble bug returns). Phase 2 step 11–12 and Phase 3 step 15 are the guards. **Never report success from a green build alone** — the patch applying is a separate signal from the build passing.
- **Watch area:** the forensic/autoheal subsystem (highest Baileys-internal coupling). Mitigated by the live QR + reconnect smoke in Phase 3/5.
