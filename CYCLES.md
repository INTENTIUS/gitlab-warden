# Cycles

A cycle reconciles one resource domain. Each run executes every selected
cycle against every declared node (`--cycles` picks a subset; the default is
all of them). For each pair, the cycle fetches live state and builds the
desired slice from config; it then diffs and guardrail-checks before planning
(dry-run) or applying. A cycle no-ops on node kinds it doesn't cover and on
nodes that don't declare its slice.

Shared behavior, so it isn't repeated 19 times:

- **Selective-by-omission.** An absent field or collection is never read for
  mutation, diffed, or changed: a cycle only acts on the slice of the policy
  it owns.
- **Ownership-gated deletes.** The diff proposes deleting a live entry
  missing from the policy only when that entry's collection is marked owned
  (`isOwned`), and by default nothing is owned: a run creates and updates
  but never deletes. A node's `owned` declaration in the policy (`true`, or
  a list of resource types — see the [policy reference](POLICY.md)) marks
  resources owned; a programmatic `diffOptions.isOwned` predicate overrides
  the declaration when supplied. The delete paths listed below run only in
  nodes that opted in.
- **Tier-gated reads are tolerated.** A declared slice whose read comes
  back 403 is tolerated and skipped, never fatal: the read yields no live
  state, and the cycle's plan gains a NOTE line naming the slice
  (`read was tier-gated (403); planned entries may fail on apply`). A
  slice you declared anyway plans as a create, and its apply lands the 403 in
  that cycle's `failed[]` (with the API message). The GraphQL cycles extend
  the same tolerance and NOTE to a CE/FOSS schema that lacks the EE field
  entirely.
- **Request budget.** A run has a shared budget of 1000 API requests. On
  exhaustion the run stops cleanly and prints `DEFERRED (budget): <cycles>`
  to stderr; run again (or narrow `--cycles`) to finish.
- **Endpoints** are REST (`/api/v4`) unless marked GraphQL.
- **Keying.** Config entries are matched to live entries by a human-stable
  key (name, url, username) rather than GitLab's numeric ids; the live ids
  are carried along for the apply path but never diffed.
- **Renames.** A `previously:` declaration (on a node, or on a webhook) is
  an explicit rename intent: when the live resource exists under the old key
  and none under the new one, the plan is a single in-place update that keeps
  the id, never a delete + create, so no `owned` is needed. Keys with no
  in-place update API (protected branch names, system hooks) stay honest
  delete + create.

Node renames run through **node-rename**, a runner-managed twentieth cycle
that is not in the registry and not selectable via `--cycles`: the runner
resolves each node's `previously:` alias against live state before scope
enumeration (scope ids are kind-prefixed full paths built from node keys, so
the alias must resolve before the node map becomes scopes), enumerates a
pending rename's scope under the old path (the live identity), and appends
the cycle after the selected ones. Every other cycle therefore reads and
writes the resource where it actually lives, and the rename
(`PUT /groups/:id` / `PUT /projects/:id` with the new path, plus the new
display name unless `groupSettings.name` manages it) lands last; the next
run finds the node at its declared path and the alias goes inert. A declared
rename resolves on every run, whatever `--cycles` selects.

The 19 registry cycles, in registry order (`src/cli/registry.ts`):

## member-roles

Custom member roles (Ultimate) on **group** and **instance** nodes; projects
no-op. Config lives in `memberRoles[]`, keyed by `name`.

- Read: `GET /groups/:id/member_roles` (paginated), or `GET /member_roles`
  on an instance node (self-managed). 403 tolerated (not Ultimate).
- Apply: `POST` on create, `DELETE …/:id` on delete. Roles are presence-only
  and are not updated in place.
- Role *assignment* is the members cycle's job (`memberRoleId` on a member);
  this cycle owns the definitions.

## compliance-frameworks

Framework definitions on top-level **group** nodes (Premium/Ultimate),
declared in `complianceFrameworks[]` and matched by `name`. **GraphQL.**

- Read: the `group.complianceFrameworks` query. 403 tolerated, as is a
  CE/FOSS schema without the field.
- Apply: `createComplianceFramework` / `updateComplianceFramework` /
  `destroyComplianceFramework` mutations. Field drift (description, color,
  pipelineConfigurationFullPath) is an update.
- Best-effort: the GraphQL operations follow the documented schema but are
  unvalidated against a live Ultimate instance (the hermetic e2e runs CE).
- Project *assignment* of frameworks is a separate, not-yet-covered concern.

## security-policies

Security-policy project linkage on **group** and **project** nodes
(Ultimate). The single `securityPolicy.policyProject` field is the whole
slice. **GraphQL.**

- The read asks for `securityPolicyProject { fullPath }` on the
  group/project, tolerating both a 403 and a schema that lacks the field.
- Apply uses the `securityPolicyProjectAssign` and
  `securityPolicyProjectUnassign` mutations, where an empty or unset
  `policyProject` unlinks.
- The policy *content* (`.gitlab/security-policies/policy.yml`) lives in the
  linked project and is already as-code there; only the linkage is
  reconciled.
- This cycle carries the same best-effort caveat as compliance-frameworks
  (the e2e runs CE).

## protected-tags

Protected tags on **project** nodes come from `protectedTags[]`; the key
`name` is a tag name or glob.

- The tag list comes from `GET /projects/:id/protected_tags` (paginated).
- Creation is a `POST`; an update tears the tag protection down and
  re-creates it, since GitLab cannot patch create access levels in place;
  `DELETE …/:name` handles deletes.

## protected-environments

Protected environments on **group** and **project** nodes (Premium; 403
tolerated), declared in `protectedEnvironments[]` under each environment's
`name`.

- Read: `GET /{groups|projects}/:id/protected_environments` (paginated).
- Apply: `POST` on create; drift is fixed by re-protecting (DELETE, then
  POST); `DELETE …/:name` on delete. `deployAccessLevels` is compared as a
  set, so order does not matter.

## deploy-keys-tokens

Two related credential surfaces in one cycle.

- **Deploy keys** (project nodes only): `deployKeys[]`, keyed by `title`.
  `GET/POST/PUT/DELETE /projects/:id/deploy_keys`. `canPush` is the only
  mutable field; the public `key` is set on create.
- **Deploy tokens** (group + project nodes): `deployTokens[]`, keyed by
  `name`, via `GET/POST/DELETE /{groups|projects}/:id/deploy_tokens`. Tokens
  are immutable, so reconciliation is by presence with no update.
- Key/token secrets are write-only (returned on create only) and never
  diffed.

## integrations

Group and project integrations (Slack, Jira, …) modeled generically so any
integration works without per-service code. Config comes from
`integrations[]`, keyed by the GitLab integration slug.

- Read: `GET /{groups|projects}/:id/integrations`; only `active`
  integrations count as live.
- Apply: `PUT …/integrations/:slug` upserts (create and update, properties
  included); `DELETE …/integrations/:slug` disables.
- `properties` are write-only (GitLab masks them), so property-only drift is
  not detected; presence and `active` are diffed, and properties are
  re-applied on every create/update.
- Declaring `active: false` turns an integration OFF: the diff plans a
  delete (GitLab's DELETE deactivates; its PUT upsert would (re)activate).
  This delete needs no `owned` — it carries explicit declared intent, unlike
  the undeclared-entry prunes that ownership gates. A declared-off
  integration that is already inactive is converged, planning nothing.

## access-tokens

Group/project access tokens (bot credentials) on **group** and **project**
nodes, listed in `accessTokens[]` by token `name`.

- Read: `GET /{groups|projects}/:id/access_tokens`, covering active,
  non-revoked tokens. A 403 (tier-gated — e.g. group access tokens on the
  gitlab.com free tier) is tolerated with the usual skip + plan NOTE rather
  than a cycle error.
- Apply: `POST` on create (name, scopes, access_level, expires_at);
  `DELETE …/:id` revokes on delete. There is no update path for a token that
  already exists.
- The token value is returned on create only. Token *policy* (max lifetime,
  who can create) is admin/top-group settings, out of scope here.

## advanced-protections

Project hardening controls; v1 covers the CI/CD **job token scope** on
**project** nodes via `jobTokenScope.inboundEnabled`.

- Read: `GET /projects/:id/job_token_scope` (403/404 tolerated).
- Apply: `PATCH /projects/:id/job_token_scope { enabled }`.
- Container/package registry protection rules are deferred sub-surfaces
  (newer, version-sensitive endpoints).

## instance-governance

Self-managed instance-level config on **instance** nodes only. Every
endpoint requires instance admin and is absent on GitLab.com, so all reads
tolerate 403/404 and the cycle manages nothing there. Three slices:

- `instanceSettings` uses `GET/PUT /application/settings` as a generic key
  passthrough (declare GitLab's snake_case keys verbatim).
- `systemHooks[]` reconciles `GET/POST/DELETE /hooks`, keyed by `url`; no
  PUT exists, so drift is fixed by delete + re-create.
- `instanceVariables[]` reconciles `GET/POST/PUT/DELETE /admin/ci/variables`,
  keyed by `key`.

## group-settings

The template cycle every other one follows. Group-level settings on
**group** nodes, read from the `groupSettings` slice.

- The read is a plain `GET /groups/:id`.
- The apply sends `PUT /groups/:id` with only the declared fields, a partial
  update, so selective-by-omission holds without read-modify-write.

## project-settings

Project-level settings on **project** nodes, driven by `projectSettings`.

- Reads use `GET /projects/:id`, topics included.
- A partial `PUT /projects/:id` applies drift; `topics` is accepted inline
  and its order is ignored in the diff.

## members

Direct membership of **group** and **project** nodes, the inheritance-aware
cycle (see the [design doc](DESIGN.md) §2). Config comes from `members[]`,
keyed by **username**.

- The read path is `GET /{groups|projects}/:id/members`, the **direct**
  roster; `/members/all` is never consulted for the diff. An inherited
  member is absent from live state and so can never become a delete
  candidate.
- The apply path resolves a username to a user id (`GET /users?username=…`)
  and then posts to `…/members`; access-level or role drift becomes
  `PUT …/members/:user_id`; delete issues `DELETE …/members/:user_id` for
  direct members only.
- Usernames are preferred in config; numeric ids work but the diff keys by
  username.
- A `memberRoleId` (Ultimate) pairs a custom role with the base access
  level.

## protected-branches

Branch protections on **project** nodes. Each `protectedBranches[]` entry
carries a `name` that is either a literal branch name or a glob.

- The read pages through `GET /projects/:id/protected_branches`.
- Creation is a `POST`; updating means DELETE then POST, because access
  levels cannot be repatched in place; deletion hits `DELETE …/:name`.
- The CE access-level model applies: single numeric push/merge/unprotect
  levels.
  `codeOwnerApprovalRequired` is Premium; a 403 lands in `failed[]`.

## push-rules

The flagship. GitLab push rules aren't version-controlled and their
inheritance is broken: copied at project creation, never propagated, so a
changed group rule never reaches existing projects. This cycle re-asserts
the declared rules on every declared node, every run.

Both **group** and **project** nodes expose the same sub-resource, declared
as the single `pushRules` object.

- Read: `GET /{groups|projects}/:id/push_rule`; 404 (no rule yet) and 403
  (not Premium) both mean "unmanaged here".
- Apply: `POST` when no rule exists, `PUT` on drift. A delete is never
  planned for this slice (removing `pushRules` from config makes it
  unmanaged, not deleted); the apply path wires `DELETE …/push_rule` only for
  library callers that construct such an entry themselves.
- Premium-gated, with the usual read/apply 403 split described at the top.

## ci-variables

CI/CD variables on **group** and **project** nodes, from `variables[]`,
identified by `(key, environmentScope)`; the same key with two scopes is two
variables.

- Read: `GET /{groups|projects}/:id/variables` (paginated).
- Apply: `POST` / `PUT` / `DELETE`, addressed by key + environment scope
  filter.
- Values are reconciled fully (variables are readable, unlike webhook
  tokens). A value omitted from config is sourced from `GITLAB_VAR_<KEY>` in
  warden's environment — the env value is diffed and drift-corrected exactly
  like a committed one; use that for values you'd rather not commit. With
  neither config value nor env var, the value is not diffed at all (the entry
  reconciles by presence, and a create writes an empty string).

## webhooks

Group and project webhooks, from `webhooks[]`, keyed by `url` (GitLab itself
addresses hooks by numeric id, which warden treats as apply-path plumbing).

- Read: `GET /{groups|projects}/:id/hooks` (paginated).
- Apply: `POST …/hooks` on create, `PUT …/hooks/:id` on drift,
  `DELETE …/hooks/:id` on delete.
- The `token` field is write-only: sent on create/update, never read back,
  never diffed.
- A hook's `previously:` (former URL) plans a rename as one `PUT` against the
  live hook id, carrying the new URL; see the shared **Renames** note above.

## baseline

Provisioning: ensures declared subgroups and projects **exist** under a
**group** node. Config comes from `baselines[]`, keyed by child `path`, and
the cycle only ever creates; it never updates or deletes a child.

- Read: `GET /groups/:id/subgroups` + `GET /groups/:id/projects` (paginated)
  for existing child paths.
- Apply: resolve the parent group's numeric id, then `POST /groups`
  (`path`, `parent_id`, optional name/visibility) or `POST /projects`
  (`path`, `namespace_id`, optional `template_name`).
- Settings of a created child belong to the settings cycles: declare the
  child as its own node.

## mr-approvals

Merge-request approval rules and settings on **project** nodes
(Premium; 403 on read tolerated). Group-level approval rules are
experimental/flag-gated in GitLab and skipped. Two slices:

- `approvalRules[]`, keyed by `name`, maps to `GET/POST/PUT/DELETE` on
  `/projects/:id/approval_rules` and `…/approval_rules/:id`. The
  `userIds`/`groupIds`/`protectedBranchIds` arrays are diffed without regard
  to order.
- `approvalSettings` (single object) reads from `GET /projects/:id/approvals`
  and applies via `POST /projects/:id/approvals`.
