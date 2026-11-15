# CLI reference

One binary, two subcommands:

```sh
gitlab-warden reconcile --config governance.yml [flags]
gitlab-warden migrate <path> [flags]
```

`reconcile` is the governance loop this page documents; with `--plan-json` it
also writes the plan as a chant change-set part. `migrate` translates
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
| `--member <name>` | the name of the policy file's directory | the workspace member the `--plan-json` part names. Giving it without `--plan-json` exits 2 |

The command accepts flags only; a positional argument is an error. Every flag
except `--allow-guardrail-override` takes a value.

## Config loading

- The file is parsed as JSON if the path ends in `.json` (case-insensitive),
  read as a TypeScript policy if it ends in `.ts`, and parsed as YAML
  otherwise.
- A `.ts` policy's default export (or an export named `policy`) is the policy.
  In `fold` mode a file that cannot be folded, for example one that reads
  `process.env`, exits 2 with `is not data` and the line and column at fault.
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
change is one entry with the address `<resourceType>.<key>` and the node's
scope id (`group:acme/platform` or `project:acme/platform/api`) as its scope,
and the member's `planDigest` covers every change set the run planned.

When a cycle errors or the request budget defers one, the plan is incomplete:
the member's status is `failed`, its `planDigest` is `null` and its `error`
says which cycles are missing. The entries the other cycles planned stay in
the part. Once the cycles have run, the file is written whatever the exit
code.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: the plan printed (dry-run), or apply completed with no failures. |
| 1 | Guardrail block: apply mode, at least one guardrail tripped, and `--allow-guardrail-override` was not set. For `migrate --strict`: error-severity findings remain. |
| 2 | Argument or config error (unknown flag, unknown cycle, unreadable or invalid config, missing auth). |
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
