# Design: hierarchy, scope model & inheritance-aware ownership

This is the load-bearing design decision for gitlab-warden (issue #3). GitLab is a
**tree** (nested groups, inherited membership), not a flat org like GitHub/Forgejo.
A naive set-diff would try to delete inherited members and fail. The rules below are
what the config/types (#4), `diff()` (#5), and the members cycle (#9) implement
against.

The single question this doc must answer unambiguously:

> **Given a member that appears live at node X, is it a delete candidate?**

Answer, up front: **only if it is a _direct_ membership at node X _and_ it is not in
the desired config _and_ it is owned (`opts.isOwned`).** An inherited or
shared-group membership is never a delete candidate at a child node.

---

## 1. Scope model

A **node** is a single group or project that the operator declares in config. warden
manages exactly the declared nodes — it does **not** auto-walk `descendant_groups`
to discover and manage the whole tree (that would silently claim ownership of nodes
the operator never named).

- Config is a map keyed by **full path** (URL-encoded when addressed):
  `acme/platform` (a group), `acme/platform/api` (a project).
- Each declared node becomes a reconcile **scope** (chant's per-scope loop). The
  scope id is the node's full path; the node "kind" (group vs project) selects which
  endpoints a cycle uses.
- Selective-by-omission applies at two levels: which **nodes** are declared, and
  which **fields/collections** within a node are declared. Anything absent is never
  read for mutation, diffed, or changed.

### Addressing & drift
- Config keys are human-readable **full paths**; warden resolves a path → numeric id
  where the API needs it (members, hooks, approval rules carry numeric ids).
- A renamed or transferred node (path no longer resolves) is treated as
  **not-found → no-op + warn**, never as a delete. We don't thrash on drift we
  didn't cause.

---

## 2. Membership: direct vs inherited (the crux)

GitLab exposes two member rosters per group/project:

| Endpoint | Returns |
|----------|---------|
| `GET /groups\|projects/:id/members` | **direct** members only |
| `GET /groups\|projects/:id/members/all` | effective = direct + inherited (ancestors) + invited/shared-group |

**Rules:**

1. **Diff against `/members` (direct) only.** Desired membership is reconciled
   against the direct roster at that node. `/members/all` may be read for
   context/reporting but is **never** the diff baseline.
2. **An inherited member is out of scope at a child node.** It does not appear in
   `/members`, so it is never a create/update/delete candidate there. `DELETE
   .../members/:user_id` on an inherited member **404s** — the grant lives at an
   ancestor; the fix (if any) belongs at that ancestor, which is a *different* node
   (and only actionable if the operator declared that ancestor).
3. **Ownership = a direct membership at this node.** `opts.isOwned("member", key)`
   gates deletes exactly as in the sibling wardens; for members, "owned" means
   "present in this node's direct roster and not pinned out by config".

### Access levels
Numeric scheme (name ↔ number), current as of GitLab 17.x–18.x:

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
warden maps to the number for the API. A custom **member role** (Ultimate, issue
#27) is referenced by id alongside a `base_access_level`.

### Access-level drift
A direct member whose live `access_level` differs from desired is an **update**
(`PUT .../members/:user_id`), not a delete+create. A child may *raise* an inherited
level via a direct membership but **cannot set a lower level than inherited** — if
config asks for a lower level than the inherited floor, that's a no-op the cycle
should detect and warn on, not an error loop.

### Removal semantics
- Node-level removal = `DELETE` a **direct** member at that node only.
- Subtree-wide purge (top-group `DELETE /groups/:id/billable_members/:user_id`) is
  **out of scope** — documented non-goal. warden reconciles per declared node, not
  across the whole billable surface.

---

## 3. Hierarchy mechanics

- **Nesting:** subgroups up to ~20 levels deep (platform limit; verify per target
  version). warden never needs the full tree — only the declared nodes — so depth is
  not a traversal concern except for the `baseline` provisioning cycle (#15), which
  may create intermediate subgroups.
- **Enumeration (only where a cycle needs siblings):** `GET /groups/:id/subgroups`
  (direct children) or `descendant_groups` (whole subtree), `GET
  /groups/:id/projects` for projects. All paginated (keyset for large trees — see
  the client, #2).
- **Transfer:** `POST /groups/:id/transfer` can reparent a node, changing its
  inherited membership out from under config. warden treats this as drift to report,
  not to fight (see §1).

---

## 4. What this means for each consumer

- **types (#4):** config is a node-keyed map; `MemberConfig` carries `{ user,
  accessLevel | memberRoleId }`. Live mirrors carry numeric ids (never diffed).
- **diff (#5):** members are diffed against the **direct** roster; deletes are
  ownership-gated; inherited members never produce entries. Access-level drift →
  update. Provide a unit test that proves an inherited-only member yields **no**
  change entry.
- **members cycle (#9):** `fetchLive` reads `/members` (direct). `apply` does
  `POST`/`PUT`/`DELETE .../members/:user_id`. Never deletes anything not in the
  direct roster.
- **runner (#6):** scopes = the declared nodes; a node's kind selects group vs
  project endpoints.

---

## Non-goals (v1)
- Auto-discovering/managing the entire group tree from a root.
- Subtree-wide member purges via `billable_members`.
- Reconciling *effective* (inherited) permissions — warden manages direct grants at
  declared nodes only.
