# gitlab-warden

<p>
  <a href="https://github.com/INTENTIUS/gitlab-warden/actions/workflows/ci.yml"><img src="https://github.com/INTENTIUS/gitlab-warden/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/INTENTIUS/gitlab-warden/actions/workflows/e2e.yml"><img src="https://github.com/INTENTIUS/gitlab-warden/actions/workflows/e2e.yml/badge.svg" alt="e2e"></a>
  <a href="https://www.npmjs.com/package/@intentius/gitlab-warden"><img src="https://img.shields.io/npm/v/@intentius/gitlab-warden" alt="npm"></a>
</p>

**Keep your GitLab groups and projects in a declared state, with guardrails
and drift correction.**

Full documentation lives at
[intentius.io/gitlab-warden](https://intentius.io/gitlab-warden/), with deep
dives on these pages.

- [Policy](POLICY.md)
- [Migrate](MIGRATE.md)
- [CLI](CLI.md)
- [Cycles](CYCLES.md)
- [CI pipelines](CI.md)
- [Setup](SETUP.md)
- [Design](DESIGN.md)

## Set up with an agent

From a checkout, Claude Code picks up the skill in
`.claude/skills/gitlab-warden` automatically. Other agents can install it with
`npx skills add INTENTIUS/gitlab-warden`, or by copying the skill directory
into `~/.claude/skills/`. Then paste this prompt, filling in the placeholders:

```text
Use the gitlab-warden skill to help me set up governance for my GitLab group
<GROUP_PATH> on <GITLAB_URL>. Author a governance.yaml nodes: policy for the
groups and projects I care about (ask me which slices matter), then run a
dry-run reconcile and walk me through the plan. Do not apply anything.
```

The skill holds the agent to dry-run until you've reviewed the plan; deletes
stay off entirely until you mark a node `owned` in the policy.

## What you need

- A clone of this repo (`git clone https://github.com/INTENTIUS/gitlab-warden`).
  The agent skill, the policy examples, and the CI templates live in it, and
  setup ends with a warden pipeline in your group, so you'll have the repo
  anyway.
- A GitLab personal access token with `api` scope: Owner on the groups you'll
  govern and Maintainer or above on projects (the [setup guide](SETUP.md)
  walks through creating one).
- Node 22+.

About ten minutes gets you to a first dry-run plan. The quickest probe needs
no clone at all:

```bash
# Dry-run: reads only, prints a plan, changes nothing.
npx @intentius/gitlab-warden reconcile --config governance.yaml --token-env GITLAB_TOKEN --mode dry-run
```

The npm package is also what your pipeline installs later (the
[CI guide](CI.md)). Add `--base-url` for self-managed (defaults to
gitlab.com). Full config + flags in [Usage](#usage) below.

Teams moving off GitHub Actions can start with
`gitlab-warden migrate .github/workflows/`, which translates the existing
workflows into a stitched `.gitlab-ci.yml` (the [migration guide](MIGRATE.md)).

## What it is

You declare desired state in YAML (selective-by-omission: an absent field is
never read, diffed, or touched); warden diffs it against the live GitLab API
and, in `apply` mode, converges it, guarded so a typo can't mass-delete.

It's a **single binary + a YAML file in CI**: no state file, no HCL, no
provider toolchain to stand up. The point is governance-as-code without the
weight, covering the **full** GitLab governance surface in one place.

Warden is stateless. It diffs against live state and reconciles, so there is
nothing to drift or import and no lock to hold, and correction is continuous:
a reconcile loop keeps running rather than applying once. Declarations are
selective-by-omission with ownership-gated deletes, which lets you manage a
slice of a large instance without claiming the rest. Dry-run is the default
mode, and a removal cap guards the apply path. Premium/Ultimate endpoints that
403 on read are tolerated and skipped, never fatal.

### Flagship: push-rule drift

GitLab push rules aren't version-controlled, and their inheritance is
**broken**: rules are copied at project creation and never propagated, so a
changed group rule never reaches existing projects (each one gets fixed by
hand). A reconcile loop that re-asserts declared push rules across a whole
group tree fixes that continuously, and it is one clear example of the model
warden applies across the *entire* governance surface.

## Coverage (the full surface)

| Scope | Cycles |
|-------|--------|
| **Group** | settings · members · subgroup/project provisioning · variables · webhooks · push rules · deploy tokens · access tokens · protected environments · integrations · compliance frameworks · security policies · member roles |
| **Project** | settings · members · protected branches · protected tags · protected environments · push rules · MR approvals · variables · webhooks · integrations · deploy keys/tokens · access tokens · advanced protections (job-token scope) · security policy attachment |
| **Instance** (self-managed) | application settings · instance CI/CD variables · system hooks · custom member roles |

REST for most of it; **GraphQL** for the few surfaces that require it
(compliance frameworks, security-policy attachment). The Ultimate-only
GraphQL cycles are best-effort (unvalidated against a live Ultimate
instance; the e2e runs CE).

## Usage

```sh
npx @intentius/gitlab-warden reconcile \
  --config governance.yaml \
  --mode dry-run \
  --token-env GITLAB_TOKEN \
  --base-url https://gitlab.example.com   # omit for gitlab.com
```

```yaml
# governance.yaml — declared nodes, keyed by full path
nodes:
  acme/platform:
    kind: group
    groupSettings: { description: "Platform team", visibility: private }
    members:
      - { user: alice, accessLevel: owner }
    pushRules: { preventSecrets: true }
  acme/platform/api:
    kind: project
    projectSettings: { mergeMethod: ff, topics: [go, service] }
    protectedBranches:
      - { name: main, pushAccessLevel: 40, mergeAccessLevel: 30 }
```

`--mode dry-run` (default) prints the plan; `--mode apply` converges it,
with the removal-cap guardrail blocking any accidental mass-delete and
tier-gated endpoints handled as described above.

## Tests

`npm test` runs the unit suite (mock-client, fully offline). The
[e2e smoke suite](https://github.com/INTENTIUS/gitlab-warden/tree/main/e2e)
is **fully hermetic**. It stands up GitLab CE via Docker Compose and
provisions its own group, project, and users with no external account or
secrets. It exercises every cycle's read path (asserting it stays read-only)
and, behind an opt-in flag, a full apply smoke. Every CE-supported cycle
applies a policy and then re-converges to an empty plan; out-of-band drift
gets corrected on the next run, and nodes declaring `owned` perform a real
delete. Tier-gated cycles assert graceful degradation instead. The
cycle-by-cycle table lives in
[e2e/README.md](https://github.com/INTENTIUS/gitlab-warden/blob/main/e2e/README.md).

```sh
eval "$(npm run --silent e2e:up)"   # compose up + mint token (GitLab CE is slow)
GITLAB_E2E_APPLY=1 npm run test:e2e:run
npm run e2e:down
```

## Inheritance-aware membership

GitLab is a *tree* of nested groups with inherited membership rather than a
flat org. Membership is diffed against **direct** members (`/members`); the
effective roster (`/members/all`) is never consulted. An inherited
member is **never** treated as deletable drift (the DELETE would fail, since
the grant lives at an ancestor). The
[scope and inheritance model](DESIGN.md) documents the rules the membership
cycle follows.

## How it relates to the sibling wardens

This is the third warden built on the shared provider-agnostic reconcile
primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant). That
core also powers [github-warden](https://github.com/INTENTIUS/github-warden)
and [forgejo-warden](https://github.com/INTENTIUS/forgejo-warden).
gitlab-warden supplies the GitLab layer: a REST + GraphQL client with a configurable host
(self-managed or GitLab.com), the config and live-state types, and the
reconcile cycles with their GitLab `diff()`.

| | github-warden | forgejo-warden | gitlab-warden |
|---|---|---|---|
| Hierarchy | flat org → repo | flat org → repo | **nested groups → projects** |
| Membership | direct | team-driven | **direct + inherited** |
| Auth | GitHub App | token, self-hosted | token, self-managed + SaaS |
| API | REST | REST | **REST + GraphQL** |
| Reconcile core | `@intentius/chant/reconcile` | (same) | (same) |
