# Running warden in CI

warden is built to live in a pipeline next to the policy file: dry-run on
merge requests, apply on the default branch, and a scheduled run to correct
drift that happens between pushes (the push-rules cycle exists for exactly
that). The exit codes make the wiring trivial: 0 clean, 1 guardrail block,
2 config error, 3 runtime/apply failure; anything non-zero fails the job.

## Token setup (GitLab CI)

1. Create a token with `api` scope and sufficient role on the declared nodes
   (see [SETUP.md](SETUP.md)). A **group access token** on the top governed
   group is a good fit: it isn't tied to a person.
2. In the policy repo, open Settings > CI/CD > Variables and add a **masked**
   and **protected** variable named `WARDEN_TOKEN` (protected means MR
   pipelines from forks and unprotected branches never see it; that is also
   why the dry-run job below works for same-repo MRs but not fork MRs).
3. The predefined `CI_JOB_TOKEN` is no substitute; its permissions are far
   too narrow for governance writes.

`$CI_SERVER_URL` is predefined in every GitLab pipeline, so the same
`.gitlab-ci.yml` works on gitlab.com and self-managed without edits.

## Sample .gitlab-ci.yml

```yaml
stages: [governance]

.warden:
  stage: governance
  image: node:22
  variables:
    GIT_DEPTH: "1"

# MR pipeline: plan only, post the diff in the job log.
governance:plan:
  extends: .warden
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npx @intentius/gitlab-warden reconcile
        --config governance.yaml
        --mode dry-run
        --base-url-env CI_SERVER_URL
        --token-env WARDEN_TOKEN

# Default branch: converge what was merged.
governance:apply:
  extends: .warden
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"
  script:
    - npx @intentius/gitlab-warden reconcile
        --config governance.yaml
        --mode apply
        --base-url-env CI_SERVER_URL
        --token-env WARDEN_TOKEN

# Scheduled drift correction (Build → Pipeline schedules, e.g. hourly):
# re-asserts declared state even when nobody pushed — this is what keeps
# push rules from silently drifting apart across projects.
governance:drift:
  extends: .warden
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  script:
    - npx @intentius/gitlab-warden reconcile
        --config governance.yaml
        --mode apply
        --base-url-env CI_SERVER_URL
        --token-env WARDEN_TOKEN
```

Notes:

- A guardrail block exits 1 and fails the apply job, which is the intended
  behavior. Review the plan; if the deletions are intended, re-run with
  `--allow-guardrail-override` (ideally as a manual job, not a default).
- Pin a version (`npx @intentius/gitlab-warden@0.2.2 …`) if you want
  reproducible pipelines.
- Narrow a job with `--cycles` (for example a fast hourly `--cycles push-rules`
  schedule plus a nightly full run) to stay well inside the 1000-request
  budget on large policies.

## From GitHub Actions

If the policy repo lives on GitHub, the same commands work there, since
warden talks to GitLab over its API regardless of where it runs:

```yaml
name: governance
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 * * * *"

jobs:
  reconcile:
    runs-on: ubuntu-latest
    env:
      GITLAB_TOKEN: ${{ secrets.GITLAB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: >
          npx @intentius/gitlab-warden reconcile
          --config governance.yaml
          --mode ${{ github.event_name == 'pull_request' && 'dry-run' || 'apply' }}
          --base-url https://gitlab.example.com
          --token-env GITLAB_TOKEN
```

Store the token as a repository secret; swap `--base-url` for your instance
(omit it for gitlab.com).
