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

Safety rules (non-negotiable):

- `--mode dry-run` is the default and is safe to run: it only reads live
  state and prints a plan. Start every task with a dry-run and show the
  operator the plan.
- Never pass `--mode apply` until a human has reviewed the rendered plan and
  approved the specific change.
- A guardrail block (exit 1) means stop and ask, not work around. Do not pass
  `--allow-guardrail-override` without explicit human approval.
- Deletes happen only in nodes whose policy declares `owned` (`true`, or a
  list of resource types). Treat adding `owned` as a destructive change: get
  explicit human approval first, then dry-run and review the planned deletes
  with the operator before any apply.
- Premium/Ultimate endpoints returning 403 on lower tiers are expected — the
  read is tolerated and skipped, not an error (an apply of a tier-gated slice
  surfaces the 403 in that cycle's `failed[]`).

Start with a narrow dry-run (`--cycles` limits the surface) and widen from
there.
