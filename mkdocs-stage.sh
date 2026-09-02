#!/usr/bin/env bash
# Stage the curated docs (which live at the repo root for GitHub) into docs/ for MkDocs.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf docs
mkdir -p docs

cp README.md POLICY.md MIGRATE.md CLI.md CYCLES.md CI.md SETUP.md DESIGN.md docs/

echo ">> staged docs/ for mkdocs"
