# Hermetic e2e smoke suite

`warden.e2e.test.ts` runs against a throwaway GitLab **CE 17.11** Docker
Compose stack (`docker-compose.yml` + `bootstrap.sh`). The suite self-skips
without `GITLAB_E2E_URL` / `GITLAB_E2E_TOKEN`; the apply smoke additionally
requires `GITLAB_E2E_APPLY=1` because it mutates the instance (group, project,
users, instance settings). Run it locally with:

```sh
eval "$(npm run --silent e2e:up)"     # compose up + mint root token (slow)
GITLAB_E2E_APPLY=1 npm run test:e2e:run
npm run e2e:down
```

## Coverage

Every cycle gets the read-only check (fetchLive + diff issues no mutating
call, on both group and project nodes). Cycles CE supports also get the full
loop: **apply** a policy, re-run to a **converged** empty plan, mutate
out-of-band and re-run to correct the **drift**, and — where `owned` applies —
a real **delete**. Premium/Ultimate cycles get the **tier-graceful** check
instead.

| Cycle | Read | Apply | Converge | Drift | Delete via `owned` | Gated-read NOTE |
|---|---|---|---|---|---|---|
| group-settings | yes | yes | yes | yes | n/a (settings) | — |
| project-settings | yes | yes | yes | yes | n/a (settings) | — |
| members | yes | yes | yes | yes | yes (+ removalLiveCap block first) | — |
| protected-branches | yes | yes | yes | yes (re-protect) | yes | — |
| protected-tags | yes | yes | yes | yes (re-protect) | yes | — |
| ci-variables | yes | yes | yes | yes | yes | — |
| webhooks | yes | yes (+ `previously:` URL rename keeps the hook id) | yes | yes | yes | — |
| node-rename (`previously:` on a node) | n/a (runner probe) | yes (project + group; same id after) | yes | n/a | n/a (never deletes) | — |
| deploy-keys-tokens | yes | yes (key + token) | yes | yes (can_push) | yes (both) | — |
| access-tokens | yes | yes | yes | n/a (immutable) | yes (revoke) | — |
| integrations | yes | yes | yes | n/a (properties write-only) | yes (`active: false` → DELETE) | — |
| advanced-protections | yes | yes | yes | yes | n/a (no delete path) | — |
| baseline | yes | yes | yes | n/a (create-only) | n/a (create-only) | — |
| instance-governance | yes | yes (settings/hook/var) | yes | yes | yes (hook + var) | — |
| push-rules | yes | — | — | — | — | 404 tolerated; optimistic plan |
| mr-approvals | yes | — | — | — | — | 404 tolerated; optimistic plan |
| protected-environments | yes | — | — | — | — | 404 tolerated; apply lands in `failed[]` |
| member-roles | yes | — | — | — | — | 404 tolerated; optimistic plan |
| compliance-frameworks | yes | — | — | — | — | missing GraphQL field tolerated; plan NOTE |
| security-policies | yes | — | — | — | — | missing GraphQL field tolerated; plan NOTE |

## Migrate validation

Beyond the cycles, the suite validates `gitlab-warden migrate` output against
the same live stack (no extra env vars; it runs whenever the suite is
configured). It migrates a realistic workflow set (a push/PR pipeline with
`needs:` + matrix, and a scheduled workflow), commits the stitched output
(root `.gitlab-ci.yml` plus per-workflow includes) into the throwaway project
via the repository commits API, then calls the project-scoped CI lint endpoint
(`POST /projects/:id/ci/lint`) so `include: local:` resolves against the
committed files. It asserts `valid: true` and that the merged config contains
every migrated job and the stitched stage union. The single-file (no-stitch)
output is lint-validated the same way.

| Scenario | Committed to repo | Lint valid | Merged jobs asserted |
| --- | --- | --- | --- |
| directory mode (stitched root + includes) | yes | yes | build, test, audit + stage union |
| single file (no stitch) | no (inline content) | yes | build, test |

Notes on the tier rows: GitLab CE signals its REST feature gates as **404**,
not 403, so on CE those reads degrade to "unmanaged" without a plan NOTE (the
NOTE fires on a real 403, e.g. gitlab.com free tier — covered by unit tests).
The CE GraphQL schema lacks the EE fields entirely, so the two GraphQL cycles
do exercise the tier NOTE end to end. The Premium/Ultimate **apply** paths
(push rules, approvals, protected environments, member roles, compliance
frameworks, security policies) remain unvalidated against a live licensed
instance.
