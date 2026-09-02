# Migrating from GitHub Actions

`gitlab-warden migrate` translates `.github/workflows/*.yml` into GitLab CI
YAML. Under the hood runs the same transformer as `chant migrate` (the
engine lives in `@intentius/chant-lexicon-gitlab`), so a single workflow
produces the same output either way. Warden adds the batch layer a real
migration needs: point it at the whole workflows directory and it translates
every file, then stitches a root `.gitlab-ci.yml` that includes them all.

```sh
# one workflow → stdout (findings go to stderr, stdout stays pipeable)
gitlab-warden migrate .github/workflows/ci.yml > .gitlab-ci.yml

# the whole directory → per-workflow files + a stitched root .gitlab-ci.yml
gitlab-warden migrate .github/workflows/ -o .
```

It is a workflow translator, not a project migration: it reads workflow YAML
and emits pipeline YAML. Repository imports, variables, and settings are the
reconcile side of warden ([POLICY.md](POLICY.md)).

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `<path>` | required | one workflow file, or a directory (typically `.github/workflows/`) |
| `-o, --output <path>` | stdout / `./` | output file (single input) or directory (directory input) |
| `--emit yaml\|ts` | `yaml` | emit provider-native YAML, or typed chant TypeScript |
| `--strict` | off | exit 1 when any finding reaches error severity (lossy findings escalate) |
| `--report <file>` | — | write the findings as SARIF v2.1.0 |
| `--use-composites` | off | rewrite recognized job shapes to chant composites (`--emit ts`) |
| `--stitch` / `--no-stitch` | on | directory mode: emit the root `.gitlab-ci.yml` of `include: local:` entries |

Exit codes follow the CLI convention: 0 success, 2 argument error, 3 runtime
error. Exit 1 means `--strict` found error-severity diagnostics, which is a
different failure than the reconcile guardrail block that also exits 1.

## What translates cleanly, and what doesn't

The transformer is explicit about fidelity: every translation decision is
recorded against one of 38 rules, and everything lossy becomes a warning
with remediation text on stderr. The tables below condense those rules.

| Translates cleanly | Becomes |
|---|---|
| `on: push` / `pull_request` / triggers | `workflow.rules` on `$CI_PIPELINE_SOURCE` |
| `env` (workflow, job, step) | `variables` |
| `needs:` | `needs:` (kept as a DAG) |
| `strategy.matrix` | `parallel.matrix` |
| `timeout-minutes`, `continue-on-error` | `timeout`, `allow_failure` |
| `concurrency` | `resource_group` / `interruptible` |
| `services:`, `container.image` | `services:`, `image` |
| `${{ github.* }}` expressions | predefined `$CI_*` variables |
| 33 common marketplace actions | native GitLab equivalents |

| Lossy (warning + remediation) | Why |
|---|---|
| `on: schedule` (`MIG-ON-SCHEDULE`) | GitLab keeps cron out of YAML; see below |
| `workflow_dispatch` inputs | need `spec:inputs` (GitLab 17+) with defaults |
| `permissions:` | no per-job equivalent; configure token access in the project |
| job `outputs:` | need the `artifacts:reports:dotenv` pattern |
| non-Linux `runs-on` | needs a self-hosted runner with tags |
| reusable workflows | become `include:project:` without typed inputs |
| unmapped marketplace actions | ported by hand |
| pinned action SHAs, secret scoping | security posture re-established on the GitLab side |

The security-fate analysis always runs. A pinned action SHA that could not
be carried, a secret that now assumes a masked and protected variable, an
injection site translated verbatim: each surfaces as a finding, so nothing
weakens silently in the move.

## Worked example

Given `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make build
```

Running `gitlab-warden migrate .github/workflows/ci.yml` puts this on
stdout.

```yaml
stages:
  - build
workflow:
  name: CI
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push"'
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_PIPELINE_SOURCE == "schedule"'

build:
  image: ubuntu:24.04
  script:
    - make build
  stage: build
```

and reports on stderr that `MIG-ON-SCHEDULE` fired, ending with a
ready-to-paste policy block (below).

In directory mode each workflow becomes `<name>.gitlab-ci.yml` and the root
`.gitlab-ci.yml` stitches them together. The root also declares the union of
every workflow's stages: GitLab merges top-level keys across includes with
the later file winning, so without the union two pipelines with different
stage lists would clobber each other.

```yaml
stages:
  - build
  - test
include:
  - local: ci.gitlab-ci.yml
  - local: nightly.gitlab-ci.yml
```

The end-to-end suite validates exactly this output against a real GitLab
instance: the stitched set is committed to a project and checked with
GitLab's own project-scoped CI lint endpoint.

## Schedules, and where this is going

GitHub puts cron in the workflow file. GitLab puts it in the project's
CI/CD settings under Pipeline schedules, so `on: schedule` cannot be carried
into the YAML. The translated rules still gate on
`$CI_PIPELINE_SOURCE == "schedule"`, which means the migrated jobs never run
until a pipeline schedule exists.

When migrate drops a schedule it prints the exact state you lost, shaped as
policy:

```yaml
pipelineSchedules:
  - description: "migrated from ci.yml"
    cron: "0 6 * * 1"
    ref: main
```

Today that block documents the manual step precisely. Phase 2 of this work
is a `pipeline-schedules` reconcile cycle that consumes it: declare the
block on a project node and warden keeps the live schedules converged with
it, drift-corrected and ownership-gated like any other slice. Migration
produces the pipeline; warden governs the destination the diagnostics point
at.

## Running it in CI

See the migrate recipe in [CI.md](CI.md) for a pipeline job that translates
workflows and uploads the SARIF report as an artifact.
