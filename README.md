# gitlab-warden

Declarative governance for GitLab **groups & projects** — the whole surface, in one lightweight tool you run in CI.

The third [warden](https://github.com/INTENTIUS/github-warden), built on the shared
provider-agnostic reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant) — the same core
behind [github-warden](https://github.com/INTENTIUS/github-warden) and
[forgejo-warden](https://github.com/INTENTIUS/forgejo-warden). gitlab-warden
supplies the GitLab layer: a REST + GraphQL client (configurable host for
self-managed + GitLab.com), config + live-state types, a GitLab `diff()`, and the
reconcile cycles.

> 🚧 **Preview published; engine in progress.** `@intentius/gitlab-warden@0.1.0` is a
> placeholder that establishes the package + release pipeline. The reconcile engine
> is being built per the [roadmap epic](https://github.com/INTENTIUS/gitlab-warden/issues/21).

## What it is

You declare desired state in YAML (selective-by-omission — an absent field is never
touched); warden diffs it against the live GitLab API and, in `apply` mode,
converges it — guarded so a typo can't mass-delete.

It's a **single binary + a YAML file in CI**: no state file, no HCL, no provider
toolchain to stand up. That's the whole point — governance-as-code without the
weight, covering the **full** GitLab governance surface in one place:

- **Stateless** — diff against live, reconcile. Nothing to drift, import, or lock.
- **Continuous drift correction** — a reconcile loop, not a one-shot apply.
- **Selective-by-omission + ownership-gated deletes** — manage a slice of a large instance without claiming the rest.
- **Guardrails + dry-run default** — removal cap, lockout protection.
- **Tier-graceful** — Premium/Ultimate-gated endpoints that 403 are reported and skipped, never fatal.

### Flagship: push-rule drift

GitLab push rules aren't version-controlled and their inheritance is **broken** —
copied at project creation, never propagated; change a group rule and existing
projects don't get it (each fixed by hand). A reconcile loop that re-asserts
declared push rules across a whole group tree fixes that, continuously. It's the
sharpest single example of the model, but warden goes after the *entire* surface.

## Coverage (the full surface)

| Scope | Cycles |
|-------|--------|
| **Group** | settings · members · subgroup provisioning · variables · webhooks · push rules · access tokens · protected environments · integrations · MR approval settings · compliance frameworks · security policies · member roles |
| **Project** | settings · members · protected branches · protected tags · protected environments · push rules · MR approvals · variables · webhooks · integrations · deploy keys/tokens · access tokens · advanced protections (job-token scope, registry/package protection) · compliance assignment · security policy attachment |
| **Instance** (self-managed) | application settings · instance CI/CD variables · system hooks · custom member roles |

REST for most of it; **GraphQL** for the few surfaces that require it (compliance
frameworks, security-policy attachment, custom roles).

## The one genuinely hard part

GitLab is a *tree* (nested groups, inherited membership), not a flat org. Membership
must diff against **direct** members (`/members`) while *reading* effective members
(`/members/all`), and must **never** treat an inherited member as deletable drift
(the DELETE fails — the grant lives at an ancestor). This is the credibility gate;
it gets a dedicated design issue (#3) that the members cycle implements against.
Everything else is a straightforward cycle on the shared harness.

## How it relates to the sibling wardens

| | github-warden | forgejo-warden | gitlab-warden |
|---|---|---|---|
| Hierarchy | flat org → repo | flat org → repo | **nested groups → projects** |
| Membership | direct | team-driven | **direct + inherited** |
| Auth | GitHub App | token, self-hosted | token, self-managed + SaaS |
| API | REST | REST | **REST + GraphQL** |
| Reconcile core | `@intentius/chant/reconcile` | (same) | (same) |
