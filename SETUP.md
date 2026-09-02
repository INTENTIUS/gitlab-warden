# Setup

From zero to a reviewed governance plan. Nothing here mutates GitLab — the
default mode is dry-run, and this page stops right before `--mode apply`.

## 1. Install

No install needed with npx:

```sh
npx @intentius/gitlab-warden
```

Or install the `gitlab-warden` binary:

```sh
npm install -g @intentius/gitlab-warden
```

Node 20+ (the CLI is a single bundled ESM file; `yaml` is its only runtime
dependency beside the shared reconcile core).

## 2. Create a token

warden authenticates with a plain API token sent as `PRIVATE-TOKEN`. Either:

- **Personal access token**: avatar → Edit profile → Access tokens → add a
  token with the **`api`** scope.
- **Group access token** (better for CI): group → Settings → Access tokens →
  scope `api`, role **Owner** (or Maintainer if you only govern projects).
  On GitLab.com this needs a paid namespace; on self-managed it works on Free.

Role requirements on the nodes you declare:

| Node kind | Needed role |
|---|---|
| `group` | Owner (member management, group settings, tokens) |
| `project` | Maintainer or above |
| `instance` | instance admin (self-managed only) |

Export it; never put it in the config file or on the command line:

```sh
export GITLAB_TOKEN=glpat-…
```

`--token-env` names a different variable if you prefer.

## 3. Point at your instance

gitlab.com is the default. For self-managed, pass the instance URL:

```sh
--base-url https://gitlab.example.com        # literal
--base-url-env CI_SERVER_URL                 # or from an env var (nice in CI)
```

The client talks to `<base-url>/api/v4` (REST) and `<base-url>/api/graphql`
(the two Ultimate GraphQL cycles).

## 4. First dry-run

Write a minimal policy — one group, one project, one slice each
(the full schema is in [POLICY.md](POLICY.md)):

```yaml
# governance.yaml
nodes:
  acme/platform:
    kind: group
    pushRules:
      preventSecrets: true
  acme/platform/api:
    kind: project
    protectedBranches:
      - name: main
        pushAccessLevel: 40
        mergeAccessLevel: 30
```

Run it:

```sh
npx @intentius/gitlab-warden reconcile --config governance.yaml
```

Dry-run is the default: it reads live state and prints one plan section per
cycle and node (`=== push-rules @ group:acme/platform ===`), changing
nothing. What to expect:

- Slices you didn't declare produce no entries — selective-by-omission.
- On a Free/CE instance the push-rules read 403s and is skipped with a note;
  that is normal, not an error (tier-graceful).
- Live things you didn't declare are left alone; nothing is ever deleted by
  a CLI run.

Narrow the run while iterating (`--cycles push-rules,protected-branches`),
widen the policy node by node, and only reach for `--mode apply` once the
printed plan says exactly what you meant. [CLI.md](CLI.md) has the full flag
and exit-code reference; [CI.md](CI.md) shows the pipeline wiring.

## 5. A disposable sandbox: the e2e stack

The repo ships a fully hermetic e2e environment — GitLab CE in Docker
Compose, no external account, no secrets — which doubles as a safe place to
try `--mode apply` for real:

```sh
git clone https://github.com/INTENTIUS/gitlab-warden && cd gitlab-warden
npm ci
eval "$(npm run --silent e2e:up)"   # compose up + mint a root token
```

Fair warning: GitLab CE is heavy (multi-GB image) and first boot runs
`gitlab-ctl reconfigure` — a few minutes locally, up to ~15 on small
machines. The bootstrap script waits and reports progress. When it finishes
it exports:

- `GITLAB_E2E_URL` — `http://localhost:8929`
- `GITLAB_E2E_TOKEN` — a root `api`-scope token (24h expiry)

Point warden at it and do whatever you like — it's yours:

```sh
npx @intentius/gitlab-warden reconcile \
  --config governance.yaml \
  --mode apply \
  --base-url-env GITLAB_E2E_URL \
  --token-env GITLAB_E2E_TOKEN
```

(Create a top-level group first — log in as `root` at http://localhost:8929
with the password from `e2e/docker-compose.yml`; once a group exists,
`baselines` entries can provision everything under it.) The e2e suite itself
(`npm run test:e2e:run`) provisions its own group/project and exercises every
cycle against this stack. Tear it all down, state included:

```sh
npm run e2e:down
```
