---
name: gitlab-warden
description: Set up and run declarative GitLab governance in this repo via the gitlab-warden CLI — author a nodes: policy for groups/projects/instance, dry-run a reconcile, read the plan, and apply with guardrails. Use when an operator asks for help setting up or configuring GitLab group or project governance here.
---

# gitlab-warden

Use the **`gitlab-warden` CLI** to govern GitLab from this repo. This skill is
a pointer — read the docs, do not restate them:

- [POLICY.md](../../../POLICY.md) — authoring the `nodes:` policy file (every
  field, per-slice tables, tiers).
- [SETUP.md](../../../SETUP.md) — PAT creation and scopes, self-managed
  `--base-url`, first dry-run, the disposable e2e sandbox.
- [CLI.md](../../../CLI.md) — flags, config loading, exit codes.
- [CYCLES.md](../../../CYCLES.md) — what each of the 19 cycles reads and
  reconciles.
- [DESIGN.md](../../../DESIGN.md) — the scope and inheritance model (why
  inherited members are never drift).

Safety rules (from the code, non-negotiable):

- `--mode dry-run` is the default and is safe: it reads live state and prints
  a plan, changing nothing. Start there, always.
- Never pass `--mode apply` until a human has reviewed the rendered plan.
- Exit 1 means a guardrail block (the removal cap tripped): stop and ask.
  `--allow-guardrail-override` requires explicit human approval.
- Premium/Ultimate endpoints returning 403 on lower tiers are expected — they
  are reported and skipped, not errors.

Start with a narrow dry-run (`--cycles` limits the surface) and widen from
there.
