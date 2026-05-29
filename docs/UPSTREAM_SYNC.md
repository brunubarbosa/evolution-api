# Upstream Sync Runbook

How to bring `vendor/gdw` up to date with `EvolutionAPI/evolution-api:main` (or any newer upstream tag).

> **Two independent axes.** Evolution and Baileys are bumped separately. Upstream Evolution (even 2.4.0/`develop`) pins `baileys@7.0.0-rc.9`, so a Baileys upgrade is *our* decision, not something inherited from an Evolution rebase. This file's "Procedure" section below covers the **Evolution rebase**; the "Baileys-only version bump" section covers the **Baileys** axis. The 2026-05-29 rc10→rc13 bump used the Baileys-only path — see `docs/BAILEYS_UPGRADE_rc10_to_rc13.md` for the worked example. Note: moving to Evolution 2.4.0 introduces a mandatory license-activation gate (#2530) — do not rebase onto 2.4.0 without a plan for it.

## Baileys-only version bump

When all you need is a newer Baileys (security fix, protocol fix) and you are staying on the current Evolution base:

1. Bump the pin in `package.json` — keep it an **exact** pin (no caret); a caret on a prerelease lets a future `npm install` drift to a different rc and break the patch's version-match.
2. `npm install baileys@<new-version>` to refresh `package-lock.json` (npm may re-add a caret — revert it).
3. **Regenerate the patch.** `patch-package` matches `patches/baileys+<EXACT-installed-version>.patch`. The old file will not match the new version and silently no-ops (build succeeds, ships unpatched — the 2026-05-13-class trap). To regenerate: move the old patch aside, `git apply --check` it against the new `node_modules/baileys/lib` (if context matches, the compiled output is unchanged), apply it, then `npx patch-package baileys` to emit `baileys+<new-version>.patch`. `git rm` the old file.
4. **Verify** the regenerated patch is semantically identical to the old one: `diff <(grep -vE '^index ' old.patch) <(grep -vE '^index ' new.patch)` should be empty (differences only in blob-hash `index` lines). If the source files changed between versions, re-apply the hunks by hand and re-confirm each `// [GDW]` block landed in the right function.
5. **Confirm a clean `npm ci`** prints `baileys@<new-version> ✔` (this is the CI/Docker path). Then `npm run build` (tsc) and the Docker smoke below.
6. **Before bumping, check the changed-file surface:** `git -C ../baileys-source log --oneline <old-tag>..<new-tag> -- src/Socket/messages-send.ts src/Utils/link-preview.ts src/Types/Message.ts`. Zero commits on those three = the patch will re-apply cleanly. Non-zero = expect to re-roll hunks by hand.

The rest of this file (rebase, conflict hot-spots, smoke, deploy verification) applies to both axes.

## Cadence

- **Monthly minimum.**
- **On-demand** when we need a Baileys version bump or a published security fix.

If you skip a month, log it in `PATCHES.md` with a one-line "deferred to YYYY-MM" note. A four-month gap is the danger zone — the patched file (`whatsapp.baileys.service.ts`) is *the* file Evolution churns every release.

## Procedure

```bash
cd ../evolution-api
git fetch origin                           # origin = upstream EvolutionAPI/evolution-api
git fetch fork                             # fork   = brunubarbosa/evolution-api
git checkout vendor/gdw
git rebase origin/main                     # NOT merge — we want a clean linear patch series
# resolve conflicts (see hot-spots below)
# smoke-test locally (see below)
git push fork vendor/gdw --force-with-lease
```

We rebase, not merge, because the patch surface must stay reviewable as N small commits, not a tangle of merge commits. `--force-with-lease` is safe because no one else writes to `vendor/gdw`.

## Conflict hot-spots

Every rebase, expect conflicts in roughly these locations. Always resolve them by **keeping our `// [GDW]` blocks** and reapplying them on top of upstream's new code if upstream restructured around them.

| File | Where | Why |
|------|-------|-----|
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | `groupHandler` block (~line 1815-1925) | Upstream churns the participants handler shape every release. GDW-001 adds fields to its return; GDW-002 adds a sibling handler. |
| same file | dispatch loop (~line 2076-2110) | Upstream adds new `if (events['…']) { … }` branches; our GDW-002 branch must remain. |
| `src/api/types/wa.types.ts` | `enum Events` | Upstream adds new event names; preserve `GROUP_JOIN_REQUEST` line. |
| `src/api/integrations/event/event.controller.ts` | `events` array | Same as above. |
| `src/validate/instance.schema.ts` | 4 transport enum lists | `GROUP_JOIN_REQUEST` must remain in all 4. |

If the dispatch loop has been restructured (e.g. upstream added a new abstraction), the resolution is to manually re-apply the GDW dispatches in the new structure, then update `PATCHES.md` with a note about the restructure.

## Smoke test (must pass before push)

```bash
docker build -t gdw-evolution:smoke .
docker run -d --rm --name smoke -p 18080:8080 \
  -e SERVER_TYPE=http -e SERVER_PORT=8080 \
  -e AUTHENTICATION_API_KEY=smoke-test-key \
  -e DATABASE_ENABLED=false \
  -e CACHE_REDIS_ENABLED=false \
  -e CACHE_LOCAL_ENABLED=true \
  gdw-evolution:smoke

# Wait ~10s for boot
curl -fsS http://localhost:18080/ && echo OK
docker stop smoke
```

If the smoke passes, push. CI will re-run it (and Trivy + cosign sign) on push.

## Verification after deploy

After CI publishes the new digest and Coolify pulls it:

1. `docker logs gdw-evolution-api | grep -i error` — no startup errors
2. Send a synthetic `GROUP_PARTICIPANTS_UPDATE` webhook through a managed test group → assert `actor_jid` populated in `stats.participant_events`
3. Send a synthetic invite-link join → assert row in `stats.join_requests`
4. Watch worker logs for any `[webhook]` warnings for 30 min

## Upstreaming patches

When a patch is a clean upstream bug fix (e.g. GDW-001's `author` preservation), open a PR against `EvolutionAPI/evolution-api`:

1. From `vendor/gdw`: `git format-patch origin/main..vendor/gdw -- <files>` (or cherry-pick)
2. Apply on a fresh branch off upstream `main`
3. Strip `// [GDW]` markers (they reference our internal registry)
4. Open PR with the same explanation as the `PATCHES.md` entry
5. Update `PATCHES.md` status to `[upstream-pr-pending]` with the PR URL

If/when merged, on the next sync the patch will arrive via `origin/main` and we delete the local entry.
