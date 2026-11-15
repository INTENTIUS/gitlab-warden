# CLI reference

One binary, three subcommands:

```sh
gitlab-warden reconcile --config governance.yml [flags]
gitlab-warden repos [--out <file>] [flags]
gitlab-warden migrate <path> [flags]
```

`reconcile` is the governance loop this page documents; with `--plan-json` it
also writes the plan as a chant change-set part. `repos` writes the policy's
group's project list for `chant workspace check --forge-repos` (see "repos"
below). `migrate` translates
GitHub Actions workflows into GitLab CI YAML and has its own page
([MIGRATE.md](MIGRATE.md), flags included). `gitlab-warden --help` (or no
arguments, or `--help` after a subcommand) prints usage;
`gitlab-warden --version` prints the version (inlined from package.json at
build time).

## Reconcile flags

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | `governance.yml` | governance config file (YAML, JSON when the path ends in `.json`, or a TypeScript policy when it ends in `.ts`). Without the flag, `governance.yml` in the working directory; when only `governance.yaml` is there, that file is read with a deprecation note on stderr; when neither is there, `governance.ts` is read. A path naming `governance.yaml` gets the same note, as does a path naming `governance.yml` that is missing when the `governance.yaml` beside it exists, which is then read instead |
| `--config-mode fold\|run\|check` | `fold` | how a `.ts` policy is evaluated: `fold` reduces it to its value without running it, `run` imports it, `check` does both and exits 2 if they differ. YAML and JSON policies ignore it |
| `--mode dry-run\|apply` | `dry-run` | `dry-run` computes and prints the plan; `apply` mutates after guardrails pass |
| `--cycles <name[,name…]>` | all 20 | comma-separated cycle names to run (see [CYCLES.md](CYCLES.md)); an unknown name is an error listing the known ones |
| `--base-url <url>` | `https://gitlab.com` | GitLab instance URL for self-managed, e.g. `https://gitlab.example.com` |
| `--base-url-env <VAR>` | — | read the base URL from an env var instead (`--base-url` wins if both are given) |
| `--token-env <VAR>` | `GITLAB_TOKEN` | env var holding the API token; the run fails (exit 2) if it is unset or empty |
| `--allow-guardrail-override` | off | apply even when a guardrail trips |
| `--removal-cap-fraction <f>` | `0.25` | max deletable fraction of each resource type's live entries per apply; must be in `(0, 1]` or the parse fails with exit 2 |
| `--plan-json <file>` | none | also write the plan to the file as a chant change-set part (see "Plan as a change-set part" below). Nothing is applied: combining it with `--mode apply` exits 2 |
| `--member <name>` | the name of the policy file's directory | the workspace member the `--plan-json` part and the `--drift-issue` records name. Giving it without either flag exits 2 |
| `--drift-issue` | off | keep one GitLab issue tracking the drift this dry run finds (see "Drift issue" below). Combining it with `--mode apply` or with `--cycles` exits 2 |
| `--drift-issue-repo <path>` | `CI_PROJECT_PATH` | the project the drift issue lives in, as a full path (`group/project`, subgroups allowed) or a numeric id. Giving it without `--drift-issue` exits 2 |

The command accepts flags only; a positional argument is an error. Every flag
except `--allow-guardrail-override` takes a value.

## Config loading

- The file is parsed as JSON if the path ends in `.json` (case-insensitive),
  read as a TypeScript policy if it ends in `.ts`, and parsed as YAML
  otherwise.
- A `.ts` policy's default export (or an export named `policy`) is the policy.
  In `fold` mode a file that cannot be folded exits 2 with `is not data` and
  the line and column at fault. One that reads `process.env` is an example.
  In `check` mode a file whose folded and run values differ exits 2 with both
  values. See [POLICY.md](POLICY.md#a-policy-in-typescript).
- The result must be an object with a `nodes` map ([POLICY.md](POLICY.md)
  documents the schema). Anything else is rejected with exit 2.

## Auth and token scopes

The token is sent as the `PRIVATE-TOKEN` header against `<base-url>/api/v4`
(REST) and `<base-url>/api/graphql` (the GraphQL cycles). Use a personal
access token or a group access token with:

- **`api` scope** (required; the reconcile both reads and writes).
- **Owner** on declared group nodes and **Maintainer or above** on declared
  project nodes (member management, protected branches, tokens, and settings
  writes need those roles).
- **Instance admin** for `kind: instance` nodes (`/application/settings`,
  `/hooks`, and `/admin/ci/variables` are admin-only and absent on
  GitLab.com, where the instance-governance cycle simply manages nothing).

Never pass the token on the command line; export it and name the variable via
`--token-env`.

## Modes, guardrails, budget

- **dry-run** (default): reads live state, prints a per-cycle plan
  (`=== <cycle> @ <scope> ===`), changes nothing. When a declared slice's read
  was tier-gated, the plan ends with
  `NOTE: <slice>: read was tier-gated (403); planned entries may fail on apply`.
- **apply**: applies each planned entry, then prints
  `Applied: N, Failed: M` per cycle with one `FAILED [type] key: error` line
  per failure (e.g. a 403 from a tier-gated endpoint).
- **Guardrail**: the per-collection removal cap bounds how much of any one
  resource type's live entries a single apply may delete — the exact
  promise lives with the delete semantics in [POLICY.md](POLICY.md). A
  tripped guardrail prints `GUARDRAIL BLOCK: …`, skips that cycle's apply,
  and exits 1; `--allow-guardrail-override` applies anyway, and
  `--removal-cap-fraction` adjusts the threshold.
- **Request budget**: a run has a shared budget of 1000 API requests. On
  exhaustion the run stops cleanly and prints `DEFERRED (budget): <cycles>`
  to stderr; run again (or narrow `--cycles`) to finish.

## Where a drifted field was written

When the policy is a `.ts` file loaded in `fold` (the default) or `check`
mode, each drifted field in an update is followed by a line saying where the
policy wrote the value it wants back:

```
UPDATE:
  [project-settings] project-settings
    mergeMethod: merge → ff
      <- reviewPreset(...) argument linear at examples/governance.ts:20:50
    topics: ["api"] → ["service","api"]
      <- direct
```

| Origin line | Meaning |
|---|---|
| `direct` | the value is written on the field itself in the policy |
| `<fn>(...) argument <param> at <file>:<line>:<col>` | a function in the policy (a preset) set the field from one of its parameters; the location is the argument at the call, so change the argument to change the field. When the parameter's default applied, the line names the call instead |
| `<fn>(...) sets it in its body at <file>:<line>:<col>, called at ...` | the function's body fixes the value, so the edit belongs in the function |
| `unknown (<reason>)` | the fold could not attribute the value; it is never reported as `direct` |

File paths are relative to the working directory, or absolute when the policy
is outside it. A YAML or JSON policy, or a `.ts` policy loaded with
`--config-mode run`, prints the plan without these lines. The same origins are
on each cycle result's `origins` field when warden is used as a library
(`import { loadGovernancePolicy } from "@intentius/gitlab-warden"`, then pass
the loaded `provenance` to `runReconcile`).

## Plan as a change-set part

`--plan-json <file>` writes the run's plan as one part of a chant change-set
document, so a governance member's planned changes can sit next to the rest of
a workspace's plan. The file is the output of `reconcilePlanPart` from
`@intentius/chant/change-set`, and chant reads it back with
`readChangeSetPartFile(part, "warden", member, "gitlab")`.

```sh
gitlab-warden reconcile \
  --config members/governance/governance.yml \
  --plan-json governance.plan.json
```

The part's member is named by `--member`, or by the policy file's directory
(`governance` above) when the flag is absent; without `--config`, that is the
working directory's name, and a policy at the filesystem root needs
`--member`. Its planner is `warden` and its lexicon `gitlab`. Each planned
change is one entry with the node's scope id (`group:acme/platform` or
`project:acme/platform/api`) as its scope, and the member's `planDigest`
covers every change set the run planned.

An entry's address puts it on the same graph node as the drift reader's record
for that change (see the README's
[drift section](README.md#as-a-chant-workspace-member)). A change to a node's
own state has the bare node id as its address. The settings type that matches
the node's kind is its own state (`group-settings` for a group,
`project-settings` for a project and `instance-settings` for an instance), and
a protected branch or an integration is a node of its own
(`protection/<project>/<branch>`, `app/<path>/<integration>`). Any other change has the address
`<node id>#<resourceType>[<key>]`, such as `team/acme/platform#member[alice]`
or `repo/acme/platform/api#variable[DEPLOY_KEY]`, and chant places it on the
node before the `#`. Addresses carry the full path, so two groups that each
have an `api` project give distinct ones. An instance's entries place on no
node, since the graph does not draw an instance. A pending rename's change set
runs under the old path but its entries address the declared node. Placing
these addresses needs chant `0.124.97` or newer; an older chant leaves every
entry off the graph.

When a cycle errors or the request budget defers one, the plan is incomplete:
the member's status is `failed`, its `planDigest` is `null` and its `error`
says which cycles are missing. The entries the other cycles planned stay in
the part. Once the cycles have run, the file is written whatever the exit
code.

## Drift issue

`--drift-issue` turns a dry run's plan into one GitLab issue that tracks the
drift, through `keepDriftIssue` from `@intentius/chant/drift-issue`. A run
that finds drift opens the issue, or updates the open one when the drift
changed; a run with the same drift leaves it as it is, so a scheduled job
never opens a second issue; a run that finds none closes it with a comment.
A run where a cycle errored or was deferred proves nothing, so it leaves an
open issue alone. An issue closed by hand stays closed, and the next drift
opens a new one.

```sh
gitlab-warden reconcile --drift-issue --drift-issue-repo acme/governance
```

The issue lives in the project `--drift-issue-repo` names, else in
`CI_PROJECT_PATH`, the project the pipeline runs in; with neither the run
exits 2 before any cycle runs. It is on the instance the warden governs and
is written with the warden's own token (`--token-env`), which needs the `api`
scope on that project. The records are the drift reader's (see "Drift for
chant workspaces" below), so the issue lists the same addresses
`chant workspace drift` reports: each node with planned changes is `drifted`.
That covers a declared item that is missing on GitLab, one that differs, and an
owned one the policy does not declare. The issue's title is
`Governance drift on <host>/<top-level paths>`, for example
`Governance drift on gitlab.com/acme`, and a hidden marker with the same name
finds it again. The pipeline's `CI_PIPELINE_URL` is linked from the body.

The issue is kept after the plans print and before the exit code is decided,
also on a run whose cycles errored. The job log gets one line such as
`Drift issue: opened #4 https://gitlab.com/acme/governance/-/issues/4`. A
GitLab error while keeping the issue prints
`gitlab-warden: error: keeping the drift issue failed: <message>` and exits
3. A dry run with drift still exits 0, as without the flag.

## Drift for chant workspaces

The drift reader `chant workspace drift --member <name>` runs for a
`forge-governance` member is not a subcommand. chant imports
`dist/drift-reader.mjs` from the package and calls it in its own process
(chant `0.124.96` or later). It reads the member's `governance.yml` and runs
the same plan `reconcile --mode dry-run` prints, with every cycle. The token
comes from `GITLAB_TOKEN` and the instance from `GITLAB_BASE_URL` (default
`https://gitlab.com`). It never applies. There is one record per declared
node, read `live-read`: `in-sync`, or `drifted` with each planned change under
the node as an attribute; [README.md](README.md#drift-in-a-chant-workspace)
lists the addresses and statuses.

## repos

`repos` lists every project of the group the policy governs, its subgroups'
projects and archived ones included, and writes the list in the format
`chant workspace check --forge-repos <file>` reads. chant never asks the forge
itself: it compares this list with an org workspace's `repo` members, and
reports a repository the forge lists that no member names (WSP014) and a
member naming a repository the forge no longer lists (WSP015). An archived
project need not be declared. Projects that other namespaces share with the
group are left out.

```sh
gitlab-warden repos --config governance.yml --out forge-repos.json

chant workspace check --forge-repos forge-repos.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | `governance.yml` | policy file, found and read the same way as for `reconcile` |
| `--config-mode fold\|run\|check` | `fold` | how a `.ts` policy is evaluated, as for `reconcile` |
| `--group <path>` | the policy's only top-level group | the group to list, by full path; it must be one of the policy's `kind: group` nodes, a subgroup node included. A policy with several top-level groups needs it. `--org <path>` is the same flag under the name forgejo-warden and github-warden use |
| `--out <file>` | stdout | file to write the list to |
| `--base-url <url>` | `https://gitlab.com` | GitLab instance URL for self-managed |
| `--base-url-env <VAR>` | none | read the base URL from an env var instead (`--base-url` wins if both are given) |
| `--token-env <VAR>` | `GITLAB_TOKEN` | env var holding the API token; `read_api` scope is enough, and it needs to see the group's private projects |

A top-level group is a group node that no other group node in the policy
contains, so a policy declaring `acme` and `acme/platform` lists `acme` by
default. The output names the forge and the group (as `org`, the field chant
reads) and lists each project by its web URL, sorted, with `archived: true` on
an archived one:

```json
{
  "forge": "gitlab",
  "org": "acme",
  "repos": [
    { "url": "https://gitlab.com/acme/api" },
    { "url": "https://gitlab.com/acme/legacy", "archived": true },
    { "url": "https://gitlab.com/acme/platform/runner" }
  ]
}
```

chant matches URLs by host and full path, so a member that names the project
by its https or ssh clone URL, with or without `.git`, matches the web URL
here. A group the instance does not have, or one the token cannot see, exits 3
rather than writing an empty list, which chant would read as every member
dropped. A policy with no group node, several top-level groups and no
`--group`, or a `--group` the policy does not declare exits 2.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: the plan printed (dry-run), or apply completed with no failures. |
| 1 | Guardrail block: apply mode, at least one guardrail tripped, and `--allow-guardrail-override` was not set. For `migrate --strict`: error-severity findings remain. |
| 2 | Argument or config error (unknown flag, unknown cycle, unreadable or invalid config, missing auth, a group `repos` cannot pick). |
| 3 | Runtime error (API failure, an errored cycle, failed apply entries, or a file that could not be written). |

In CI, that means: a dry-run job fails only on real errors, and an apply job
fails loudly on a guardrail trip (1) or partial application (3). See
[CI.md](CI.md).

## Examples

```sh
# Plan everything against gitlab.com
gitlab-warden reconcile --config governance.yml

# Apply only the flagship push-rule reconcile against self-managed
export GITLAB_TOKEN=glpat-…
gitlab-warden reconcile --config governance.yml \
  --mode apply --cycles push-rules \
  --base-url https://gitlab.example.com

# A TypeScript policy, checked: folded and run, refused if the two disagree
gitlab-warden reconcile --config governance.ts --config-mode check

# Base URL and token both from the environment (CI-friendly)
gitlab-warden reconcile --config governance.yml \
  --base-url-env CI_SERVER_URL --token-env WARDEN_TOKEN
```
