# gitlab-warden

Declarative governance for GitLab **groups & projects** — stateless, drift-correcting reconcile you run in CI.

The third [warden](https://github.com/INTENTIUS/github-warden), built on the shared
provider-agnostic reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant) — the same core
behind [github-warden](https://github.com/INTENTIUS/github-warden) and
[forgejo-warden](https://github.com/INTENTIUS/forgejo-warden). gitlab-warden
supplies the GitLab-specific layer: a REST client (configurable host for
self-managed + GitLab.com), config + live-state types, a GitLab `diff()`, and the
reconcile cycles.

> 🚧 **Planning stage — not yet scaffolded.** The scope and build order live in the
> [roadmap epic](https://github.com/INTENTIUS/gitlab-warden/issues) and its
> cold-handoff sub-issues. This README captures the *why* and the deliberate scope.

## Positioning (read before building)

Unlike github/forgejo, GitLab is **not** a coverage-gap story. The
[Terraform GitLab provider](https://registry.terraform.io/providers/gitlabhq/gitlab/latest)
is broad and mature, and GitLab ships substantial native governance (compliance
frameworks, security policies-as-code, push rules, approval rules) — albeit
heavily tier-gated (Premium/Ultimate). So gitlab-warden wins on **operating
model**, not surface:

- **No state file** — diff desired YAML against live, reconcile. No Terraform state to drift, import, or lock.
- **Continuous drift correction** — a reconcile loop, not a one-shot apply.
- **Selective-by-omission + ownership-gated deletes** — manage a slice of a large GitLab instance without importing the world.
- **Guardrails + dry-run default** — removal cap, lockout protection.
- **Lightweight** — `npx`, runs in CI, no provider/state plumbing.

### The flagship value: push-rule drift

GitLab push rules are **not version-controlled, and their inheritance is broken** —
they're *copied at project creation* and never propagate, so changing a group rule
doesn't reach existing projects (each must be fixed by hand). Terraform has **no
group-level push-rule resource at all**. A reconcile loop that re-asserts declared
push rules across a whole group tree fixes a real, named pain that **neither native
GitLab nor Terraform solves**. Lead with this.

### Honest non-claims

- We do **not** "bring Ultimate features to Free" — the GitLab API itself gates
  approval rules, push rules, etc. behind Premium/Ultimate. warden reconciles what
  the token can write; it adds the *model*, never a tier bypass.
- We do **not** claim "Terraform can't do this." It mostly can. We're the
  stateless, drift-correcting, run-it-in-CI alternative.

## Deliberate scope

GitLab is harder than the flat GitHub/Forgejo org model, for two reasons baked
into the plan:

1. **Hierarchy + inherited membership is the hard part.** Nested groups (up to ~20
   deep) and members inherited from ancestor groups break the flat set-diff the
   other wardens share. Membership must diff against **direct** members
   (`/members`) while *reading* effective members (`/members/all`), and must
   **never** treat an inherited member as deletable drift (the DELETE fails — the
   grant lives at an ancestor). This is the credibility gate; it gets a dedicated
   design issue that the members cycle depends on.
2. **Compliance frameworks + security policies are GraphQL-only** *and* security
   policies are already good native as-code (Ultimate YAML). Highest cost, lowest
   marginal value — **deferred out of the MVP** (REST-only).

### MVP cycles (all clean REST)
`group-settings` · `project-settings` · `members` (group+project, inheritance-aware) ·
`protected-branches` · **`push-rules`** (flagship) · `mr-approvals` (rules+settings) ·
`ci-variables` (group+project) · `webhooks` (group+project) · `baseline` (provision subgroups/projects)

### Deferred (post-MVP, demand-gated)
`compliance-frameworks` (GraphQL) · `security-policies` (GraphQL; already native as-code) ·
`integrations` (per-service sprawl) · `access-token-governance`

## How it relates to the sibling wardens

| | github-warden | forgejo-warden | gitlab-warden |
|---|---|---|---|
| Hierarchy | flat org → repo | flat org → repo | **nested groups → projects** |
| Membership | direct | team-driven | **direct + inherited** |
| Auth | GitHub App | token, self-hosted | token, self-managed + SaaS |
| Reconcile core | `@intentius/chant/reconcile` | (same) | (same) |
