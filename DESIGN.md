# Design: hierarchy, scope model & inheritance-aware ownership

GitLab is a **tree** of nested groups with inherited membership, unlike the flat
orgs of GitHub and Forgejo. A naive set-diff would try to delete inherited members
and fail. This document defines the scope model and inheritance rules that the
config/types, `diff()`, and the membership cycle follow.

The central question it resolves:

> **Given a member that appears live at node X, is it a delete candidate?**

A member is a delete candidate **only if it is a _direct_ membership at node X, it is
not in the desired config, and it is owned (`opts.isOwned`).** An inherited or
shared-group membership is never a delete candidate at a child node.

## 1. Scope model

A **node** is a single group or project that the operator declares in config. warden
manages exactly the declared nodes; it does **not** auto-walk `descendant_groups`
to discover and manage the whole tree (that would silently claim ownership of nodes
the operator never named).

- Config is a map keyed by **full path** (URL-encoded when addressed):
  `acme/platform` (a group), `acme/platform/api` (a project).
- Each declared node becomes a reconcile **scope** (chant's per-scope loop). The
  scope id is kind-prefixed (`group:acme/platform`, `project:acme/platform/api`);
  the node "kind" (group vs project vs instance) selects which endpoints a cycle
  uses.
- Selective-by-omission applies at two levels: which **nodes** are declared, and
  which **fields/collections** within a node are declared. Anything absent is never
  read for mutation, diffed, or changed.

### Addressing & drift
- Config keys are human-readable **full paths**; warden resolves a path to the
  numeric id where the API needs it (members, hooks, and approval rules carry
  numeric ids).
- A renamed or transferred node (path no longer resolves) is treated as
  **not-found**: reads tolerate the 404 and yield no live state, so a path that
  stopped resolving never turns into a delete. (Slices declared on such a node
  still plan as creates; their apply fails visibly in `failed[]` rather than
  silently retargeting.) warden does not thrash on drift it didn't cause.

## 2. Membership: direct vs inherited

GitLab exposes two member rosters per group/project:

| Endpoint | Returns |
|----------|---------|
| `GET /groups\|projects/:id/members` | **direct** members only |
| `GET /groups\|projects/:id/members/all` | effective = direct + inherited (ancestors) + invited/shared-group |

Three rules follow:

1. Diff against `/members` (direct) only. Desired membership is reconciled
   against the direct roster at that node. The `/members/all` roster is not
   read at all — it is **never** the diff baseline.
2. An inherited member is out of scope at a child node. It does not appear in
   `/members`, so it is never a create/update/delete candidate there. A
   `DELETE .../members/:user_id` on an inherited member **404s**, because the
   grant lives at an ancestor; the fix (if any) belongs at that ancestor, which
   is a *different* node (and only actionable if the operator declared that
   ancestor).
3. Ownership means a direct membership at this node. `opts.isOwned("member", key)`
   gates deletes exactly as in the sibling wardens; for members, "owned" means
   "present in this node's direct roster and not pinned out by config". The
   runner derives the predicate from the node's `owned` declaration in the
   policy (`owned: true`, or a resource-type list including `member`; see the
   [policy reference](POLICY.md)); a caller-supplied `diffOptions.isOwned`
   predicate overrides the declaration. Either way it gates deletes of
   **direct** members only, since an inherited member is never in the diff
   baseline and so never reaches the gate.

### Access levels
Numeric scheme (name to number), current as of GitLab 17 and 18:

| # | Role |
|---|------|
| 0 | No access |
| 5 | Minimal Access |
| 10 | Guest |
| 15 | Planner |
| 20 | Reporter |
| 30 | Developer |
| 40 | Maintainer |
| 50 | Owner |

`60` (Admin) is only valid in a group *update* context; `25` (Security Manager)
appears in the access-token context. Config accepts either the name or the number;
warden maps to the number for the API. A custom **member role** (Ultimate) is
referenced by id alongside a `base_access_level`.

### Access-level drift
A direct member whose live `access_level` differs from desired is an **update**
(`PUT .../members/:user_id`), not a delete+create. A child may *raise* an inherited
level via a direct membership but **cannot set a lower level than inherited**: when
config asks for a lower level than the inherited floor, GitLab rejects the write
and the attempt surfaces in the cycle's `failed[]` output (visible every run)
rather than silently converging.

### Removal semantics
- Node-level removal means a `DELETE` of a **direct** member at that node only.
- Subtree-wide purge (top-group `DELETE /groups/:id/billable_members/:user_id`) is
  **out of scope**, a documented non-goal. warden reconciles per declared node
  and leaves the rest of the billable surface alone.

## 3. Hierarchy mechanics

- **Nesting:** subgroups up to ~20 levels deep (platform limit; confirm per target
  version). warden never needs the full tree, only the declared nodes, so depth is
  not a traversal concern except for the `baseline` provisioning cycle, which may
  create intermediate subgroups.
- **Enumeration (only where a cycle needs siblings):** `GET /groups/:id/subgroups`
  (direct children) or `descendant_groups` (whole subtree), `GET
  /groups/:id/projects` for projects. All paginated (keyset for large trees).
- **Transfer:** `POST /groups/:id/transfer` can reparent a node, changing its
  inherited membership out from under config. warden reports this drift instead
  of fighting it (see §1).

## 4. Component responsibilities

- **types:** config is a node-keyed map; `MemberConfig` carries `{ user,
  accessLevel | memberRoleId }`. Live mirrors carry numeric ids (never diffed).
- **diff:** the direct roster is the only membership baseline; deletes are
  ownership-gated; an inherited entry never produces a change. Access-level
  drift becomes an update. A unit test asserts that an inherited-only member
  yields **no** change entry.
- **members cycle:** `fetchLive` reads `/members` (direct). `apply` does
  `POST`/`PUT`/`DELETE .../members/:user_id`. It never deletes anything outside
  the direct roster.
- **runner:** scopes = the declared nodes; a node's kind selects group vs
  project endpoints.

## Non-goals (v1)
- Auto-discovering/managing the entire group tree from a root.
- Subtree-wide member purges via `billable_members`.
- Reconciling *effective* (inherited) permissions; warden manages direct grants
  at declared nodes only.
