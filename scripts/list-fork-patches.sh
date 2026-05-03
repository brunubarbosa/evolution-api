#!/usr/bin/env bash
# Lists every line in this fork that the GDW project has added or modified
# on top of upstream. Each line should reference a patch ID in PATCHES.md.
set -euo pipefail
cd "$(dirname "$0")/.."
git grep -n "\[GDW\]" -- ':!PATCHES.md' ':!scripts/list-fork-patches.sh' ':!.github/workflows/publish_ghcr_fork.yml'
