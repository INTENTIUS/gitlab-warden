#!/usr/bin/env bash
#
# Bring up the throwaway GitLab CE stack, mint a root API token, and export
# GITLAB_E2E_URL / GITLAB_E2E_TOKEN for the e2e suite.
#
# In GitHub Actions ($GITHUB_ENV set) the values are appended there; locally it
# prints `export …` lines:  eval "$(e2e/bootstrap.sh)"  then  npm run test:e2e:run
#
# ⚠️ GitLab CE boots slowly (~3-5 min). This script waits up to ~10 min.
set -euo pipefail

COMPOSE="docker compose -f e2e/docker-compose.yml"
URL="http://localhost:8929"
TOKEN="glpat-wardene2etoken1234567890"

log() { echo "[bootstrap] $*" >&2; }

log "starting GitLab CE (this is slow)…"
$COMPOSE up -d >&2

log "waiting for /-/health…"
for i in $(seq 1 120); do
  if curl -fsS "${URL}/-/health" >/dev/null 2>&1; then break; fi
  sleep 5
  if [ "$i" = "120" ]; then log "GitLab did not become healthy in time"; $COMPOSE logs --tail=50 >&2 || true; exit 1; fi
done

# Health can pass before the rails app fully accepts runner commands — retry.
log "minting a root access token via gitlab-rails…"
for i in $(seq 1 30); do
  if $COMPOSE exec -T gitlab gitlab-rails runner "
    u = User.find_by_username('root')
    u.personal_access_tokens.where(name: 'warden-e2e').delete_all
    t = u.personal_access_tokens.create!(scopes: ['api'], name: 'warden-e2e', expires_at: 1.day.from_now)
    t.set_token('${TOKEN}'); t.save!
  " >/dev/null 2>&1; then
    log "token minted"
    break
  fi
  sleep 10
  if [ "$i" = "30" ]; then log "failed to mint a token via gitlab-rails"; exit 1; fi
done

# Confirm the token authenticates.
for i in $(seq 1 12); do
  if curl -fsS -H "PRIVATE-TOKEN: ${TOKEN}" "${URL}/api/v4/version" >/dev/null 2>&1; then break; fi
  sleep 5
done

if [ -n "${GITHUB_ENV:-}" ]; then
  { echo "GITLAB_E2E_URL=${URL}"; echo "GITLAB_E2E_TOKEN=${TOKEN}"; } >> "$GITHUB_ENV"
  log "exported to \$GITHUB_ENV"
else
  echo "export GITLAB_E2E_URL=${URL}"
  echo "export GITLAB_E2E_TOKEN=${TOKEN}"
fi
