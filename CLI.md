# CLI reference

One binary, one subcommand:

```sh
gitlab-warden reconcile --config governance.yaml [flags]
```

`gitlab-warden --help` prints usage (`--help` works after a subcommand too);
`gitlab-warden --version` prints the version (inlined from package.json at
build time).

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | **required** | governance config file (YAML, or JSON when the path ends in `.json`) |
| `--mode dry-run\|apply` | `dry-run` | `dry-run` computes and prints the plan; `apply` mutates after guardrails pass |
| `--cycles <name[,name…]>` | all 19 | comma-separated cycle names to run (see [CYCLES.md](CYCLES.md)); an unknown name is an error listing the known ones |
| `--base-url <url>` | `https://gitlab.com` | GitLab instance URL for self-managed, e.g. `https://gitlab.example.com` |
| `--base-url-env <VAR>` | — | read the base URL from an env var instead (`--base-url` wins if both are given) |
| `--token-env <VAR>` | `GITLAB_TOKEN` | env var holding the API token; the run fails (exit 2) if it is unset or empty |
| `--allow-guardrail-override` | off | apply even when a guardrail trips |

The command accepts flags only; a positional argument is an error. Every flag
except `--allow-guardrail-override` takes a value.

## Config loading

- The file is parsed as JSON if the path ends in `.json` (case-insensitive),
  otherwise as YAML.
- It must be an object with a `nodes` map ([POLICY.md](POLICY.md) documents the
  schema). Anything else is rejected with exit 2.

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
  (`=== <cycle> @ <scope> ===`), changes nothing.
- **apply**: applies each planned entry, then prints
  `Applied: N, Failed: M` per cycle with one `FAILED [type] key: error` line
  per failure (e.g. a 403 from a tier-gated endpoint).
- **Guardrail**: `removalDeltaCap` refuses an apply whose deletes exceed 25%
  of the pre-existing managed entries for a cycle. A tripped guardrail prints
  `GUARDRAIL BLOCK: …`, skips that cycle's apply, and exits 1.
  `--allow-guardrail-override` applies anyway. (Deletes appear in a plan only
  for nodes whose policy declares `owned` — see [POLICY.md](POLICY.md); a node
  without it plans creates and updates only, and the cap protects the nodes
  that do opt in.)
- **Request budget**: a run has a shared budget of 1000 API requests. On
  exhaustion the run stops cleanly and prints `DEFERRED (budget): <cycles>`
  to stderr; run again (or narrow `--cycles`) to finish.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success — plan printed (dry-run) or everything applied |
| 1 | guardrail block during apply |
| 2 | argument or config error (bad flag, unknown cycle, unreadable/invalid config, missing token env var) |
| 3 | runtime error (API failure, a cycle errored, or one or more apply entries failed) |

In CI, that means: a dry-run job fails only on real errors, and an apply job
fails loudly on a guardrail trip (1) or partial application (3). See
[CI.md](CI.md).

## Examples

```sh
# Plan everything against gitlab.com
gitlab-warden reconcile --config governance.yaml

# Apply only the flagship push-rule reconcile against self-managed
export GITLAB_TOKEN=glpat-…
gitlab-warden reconcile --config governance.yaml \
  --mode apply --cycles push-rules \
  --base-url https://gitlab.example.com

# Base URL and token both from the environment (CI-friendly)
gitlab-warden reconcile --config governance.yaml \
  --base-url-env CI_SERVER_URL --token-env WARDEN_TOKEN
```
