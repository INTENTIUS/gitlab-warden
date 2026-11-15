# Changelog

Changes to `@intentius/gitlab-warden`. Versions follow semver, and releases
up to `0.6.1` are not recorded here.

## Unreleased

- The package ships a `forge-governance` member kind for chant workspaces in
  `workspace-kinds.json`, exported at `@intentius/gitlab-warden/workspace-kinds`.
  `chant workspace check` validates a member's policy file against
  `schemas/governance.schema.json`. The kind's graph reader
  (`dist/graph-reader.mjs`) gives `chant workspace graph` the groups, projects,
  protected branches and integrations the policy declares. See
  [README.md](README.md#as-a-chant-workspace-member). The kind needs chant
  0.124.49 or later.
- The `@intentius/chant`, `@intentius/chant-lexicon-gitlab` and
  `@intentius/chant-lexicon-github` range moves from `^0.72.1` to `^0.124.95`.
  `migrate` now turns a GitHub matrix flow sequence such as `[ubuntu, debian]`
  into a list in `parallel.matrix` instead of a quoted string.
- Node 24 or later is required (`engines.node` is `>=24`).
- The policy file is `governance.yml`, the name forgejo-warden and
  github-warden read. `reconcile` defaults `--config` to `governance.yml`, and
  the `forge-governance` kind checks and graphs `governance.yml`. A policy
  still named `governance.yaml` is read with a deprecation note on stderr, and
  the kind's probe still finds it; `chant workspace check` reports `WSP012`
  for such a member until the file is renamed.
