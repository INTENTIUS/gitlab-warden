# Changelog

Changes to `@intentius/gitlab-warden`. Versions follow semver, and releases
up to `0.6.1` are not recorded here.

## Unreleased

- README: the kind needs chant `0.124.96` or newer, not `0.124.49`. The kinds
  file's `drift` block is unknown to older chant, which drops the kind.

## 0.7.0 (2026-11-14)

- The package ships a `forge-governance` member kind for chant workspaces in
  `workspace-kinds.json`, exported at `@intentius/gitlab-warden/workspace-kinds`.
  `chant workspace check` validates a member's policy file against
  `schemas/governance.schema.json`. The kind's graph reader
  (`dist/graph-reader.mjs`) gives `chant workspace graph` the groups, projects,
  protected branches and integrations the policy declares. See
  [README.md](README.md#as-a-chant-workspace-member). The kind needs chant
  0.124.49 or later.
- The `@intentius/chant`, `@intentius/chant-lexicon-gitlab` and
  `@intentius/chant-lexicon-github` range moves from `^0.72.1` to `^0.124.96`.
  `migrate` now turns a GitHub matrix flow sequence such as `[ubuntu, debian]`
  into a list in `parallel.matrix` instead of a quoted string.
- Node 24 or later is required (`engines.node` is `>=24`).
- The policy file is `governance.yml`, the name forgejo-warden and
  github-warden read. `reconcile` defaults `--config` to `governance.yml`, and
  the `forge-governance` kind checks and graphs `governance.yml`. A policy
  still named `governance.yaml` is read with a deprecation note on stderr, and
  the kind's probe still finds it; `chant workspace check` reports `WSP012`
  for such a member until the file is renamed.
- The policy can be a `.ts` file whose default export is the policy, typed with
  `satisfies GovernanceConfig` from `@intentius/gitlab-warden`, the way
  forgejo-warden reads one. warden folds it to its value with
  `@intentius/tsad-reference` (`^2.3.0`, a new dependency) without running it;
  `--config-mode run` imports it instead and `--config-mode check` does both
  and exits 2 if they differ. Without `--config`, `governance.ts` is read when
  neither `governance.yml` nor `governance.yaml` is in the working directory.
  When a folded policy's field drifts, the plan names where the policy wrote
  it: `direct`, or the preset argument and its line. The package now has a
  main export with types: the policy types, `loadGovernancePolicy`, and the
  provenance helpers. See [POLICY.md](POLICY.md#a-policy-in-typescript).
- `reconcile --plan-json <file>` writes the run's plan as a chant change-set
  part (`reconcilePlanPart` from `@intentius/chant/change-set`), with lexicon
  `gitlab`, the shape forgejo-warden and github-warden write. `--member <name>`
  names the member and defaults to the policy file's directory name. A run
  where a cycle errored or was deferred writes a `failed` member with no plan
  digest. `--plan-json` cannot be combined with `--mode apply`. See
  [CLI.md](CLI.md#plan-as-a-change-set-part).
- `gitlab-warden repos [--out <file>]` writes the policy's group's project
  list, its subgroups' projects included and archived projects marked
  `archived: true`, as `{ forge: "gitlab", org, repos: [{ url, archived? }] }`,
  the file `chant workspace check --forge-repos` reads to report undeclared
  (WSP014) and dropped (WSP015) repositories. `--group` (or `--org`, the name
  the other wardens use) picks the group when the policy has several
  top-level groups. See [CLI.md](CLI.md#repos).
- The `forge-governance` kind names a drift reader (`dist/drift-reader.mjs`,
  built by `build:drift`), so `chant workspace drift --member <name>` reads a
  governance member: a dry-run reconcile of every cycle, read `live-read`,
  one record per node of the member's graph, `drifted` with the changes the
  run plans under it as attributes, or `in-sync`. A cycle that errored or was
  deferred leaves nodes `not-observed`. It takes the token from
  `GITLAB_TOKEN` and the instance from `GITLAB_BASE_URL`, and refuses with
  `no-drift-read` without a token or policy. It needs chant 0.124.96 or
  later. See
  [README.md](README.md#drift-in-a-chant-workspace).
- `reconcile --drift-issue` keeps one GitLab issue tracking the drift a dry
  run finds, through chant's `keepDriftIssue`: opened on drift, left as it is
  while the drift is the same or the read was incomplete, updated when it
  changes, closed when GitLab matches the policy. The issue lives in
  `--drift-issue-repo <group/project>` or `CI_PROJECT_PATH` and lists the
  drift reader's records. It cannot be combined with `--mode apply` or
  `--cycles`, and `--member` now names its records too. See
  [CLI.md](CLI.md#drift-issue) and [CI.md](CI.md).
