# Cycles

A cycle reconciles one resource domain. Each run (`--cycles` selects a subset;
default all) executes every selected cycle against every declared node:
fetch live state, build the desired slice from config, diff, guardrail-check,
then plan (dry-run) or apply. A cycle no-ops on node kinds it doesn't cover
and on nodes that don't declare its slice.

Common behavior, so it isn't repeated 19 times:

- **Endpoints** are REST (`/api/v4`) unless marked GraphQL.
- **Tier**: Premium/Ultimate-gated reads that 403 are tolerated — the slice is
  treated as unmanaged there, never fatal. A 403 on apply surfaces in the
  per-cycle `failed[]` output with the API message.
- **Deletes** are ownership-gated (`isOwned`) at the diff layer. Ownership is
  declared per node in the policy: `owned: true` claims every collection the
  node's cycles reconcile, `owned: [member, …]` only the listed resource
  types, and an absent `owned` (the default) means the node plans creates and
  updates only ([POLICY.md](POLICY.md)). The delete paths listed below run
  only in nodes that opted in.
- **Keying**: config entries are matched to live entries by a human-stable key
  (name, url, username, …), never by GitLab's numeric ids; live numeric ids
  are carried along for the apply path but never diffed.

The 19 cycles, in registry order (`src/cli/registry.ts`):

## member-roles

Custom member roles (Ultimate) on **group** and **instance** nodes; projects
no-op. Config slice: `memberRoles[]`, keyed by `name`.

- Read: `GET /groups/:id/member_roles` (paginated), or `GET /member_roles` on
  an instance node (self-managed). 403 tolerated (not Ultimate).
- Apply: `POST` on create, `DELETE …/:id` on delete. Presence-only — roles are
  not updated in place.
- Role *assignment* is the members cycle's job (`memberRoleId` on a member);
  this cycle owns the definitions.

## compliance-frameworks

Framework definitions on top-level **group** nodes (Premium/Ultimate).
Config slice: `complianceFrameworks[]`, keyed by `name`. **GraphQL.**

- Read: `group.complianceFrameworks` query. 403 tolerated.
- Apply: `createComplianceFramework` / `updateComplianceFramework` /
  `destroyComplianceFramework` mutations. Field drift (description, color,
  pipelineConfigurationFullPath) is an update.
- Best-effort: the GraphQL operations follow the documented schema but are
  unvalidated against a live Ultimate instance (the hermetic e2e runs CE).
- Project *assignment* of frameworks is a separate, not-yet-covered concern.

## security-policies

Security-policy project linkage on **group** and **project** nodes (Ultimate).
Config slice: `securityPolicy.policyProject`. **GraphQL.**

- Read: `securityPolicyProject { fullPath }` on the group/project. 403
  tolerated.
- Apply: `securityPolicyProjectAssign` / `securityPolicyProjectUnassign`
  mutations (an empty/unset `policyProject` unlinks).
- The policy *content* (`.gitlab/security-policies/policy.yml`) lives in the
  linked project and is already as-code there; only the linkage is reconciled.
- Best-effort, same caveat as compliance-frameworks (e2e runs CE).

## protected-tags

Protected tags on **project** nodes. Config slice: `protectedTags[]`, keyed by
`name` (tag name or glob).

- Read: `GET /projects/:id/protected_tags` (paginated).
- Apply: `POST` on create; update is DELETE then POST (GitLab can't repatch
  create access levels in place); `DELETE …/:name` on delete.

## protected-environments

Protected environments on **group** and **project** nodes (Premium; 403
tolerated). Config slice: `protectedEnvironments[]`, keyed by `name`.

- Read: `GET /{groups|projects}/:id/protected_environments` (paginated).
- Apply: `POST` on create; update is DELETE then POST (re-protect);
  `DELETE …/:name` on delete. `deployAccessLevels` is compared
  order-insensitively.

## deploy-keys-tokens

Two related credential surfaces in one cycle.

- **Deploy keys** (project nodes only): `deployKeys[]`, keyed by `title`.
  `GET/POST/PUT/DELETE /projects/:id/deploy_keys`. `canPush` is the only
  mutable field; the public `key` is set on create.
- **Deploy tokens** (group + project nodes): `deployTokens[]`, keyed by
  `name`. `GET/POST/DELETE /{groups|projects}/:id/deploy_tokens`. Immutable —
  presence-only, no update.
- Key/token secrets are write-only (returned on create only) and never diffed.

## integrations

Group and project integrations (Slack, Jira, …) modeled generically so any
integration works without per-service code. Config slice: `integrations[]`,
keyed by the GitLab integration slug.

- Read: `GET /{groups|projects}/:id/integrations` — only `active`
  integrations count as live.
- Apply: `PUT …/integrations/:slug` upserts (create and update, properties
  included); `DELETE …/integrations/:slug` disables.
- `properties` are write-only (GitLab masks them), so property-only drift is
  not detected; presence and `active` are diffed, and properties are
  re-applied on every create/update.

## access-tokens

Group/project access tokens (bot credentials) on **group** and **project**
nodes. Config slice: `accessTokens[]`, keyed by `name`.

- Read: `GET /{groups|projects}/:id/access_tokens` — active, non-revoked
  tokens.
- Apply: `POST` on create (name, scopes, access_level, expires_at);
  `DELETE …/:id` revokes on delete. Immutable — presence-only.
- The token value is returned on create only. Token *policy* (max lifetime,
  who can create) is admin/top-group settings, out of scope here.

## advanced-protections

Project hardening controls; v1 covers the CI/CD **job token scope** on
**project** nodes. Config slice: `jobTokenScope.inboundEnabled`.

- Read: `GET /projects/:id/job_token_scope` (403/404 tolerated).
- Apply: `PATCH /projects/:id/job_token_scope { enabled }`.
- Container/package registry protection rules are deferred sub-surfaces
  (newer, version-sensitive endpoints).

## instance-governance

Self-managed instance-level config on **instance** nodes only. Every endpoint
requires instance admin and is absent on GitLab.com, so all reads tolerate
403/404 and the cycle manages nothing there. Three slices:

- `instanceSettings` — `GET/PUT /application/settings`, generic key
  passthrough (declare GitLab's snake_case keys verbatim).
- `systemHooks[]` — `GET/POST/DELETE /hooks`, keyed by `url`. No PUT exists,
  so drift is fixed by delete + re-create.
- `instanceVariables[]` — `GET/POST/PUT/DELETE /admin/ci/variables`, keyed by
  `key`.

## group-settings

The template cycle every other one follows. Group-level settings on **group**
nodes. Config slice: `groupSettings`.

- Read: `GET /groups/:id`.
- Apply: `PUT /groups/:id` with only the declared fields — a partial update,
  so selective-by-omission holds without read-modify-write.

## project-settings

Project-level settings on **project** nodes. Config slice: `projectSettings`.

- Read: `GET /projects/:id` (topics included).
- Apply: partial `PUT /projects/:id`; `topics` is accepted inline and compared
  order-insensitively.

## members

Direct membership of **group** and **project** nodes — the inheritance-aware
cycle ([DESIGN.md](DESIGN.md) §2). Config slice: `members[]`, keyed by
**username**.

- Read: `GET /{groups|projects}/:id/members` — the **direct** roster only,
  never `/members/all`. An inherited member is never present in live state and
  so can never become a delete candidate.
- Apply: create resolves the username to a user id
  (`GET /users?username=…`) then `POST …/members`; access-level or role drift
  is a `PUT …/members/:user_id`; delete is `DELETE …/members/:user_id`
  (direct members only).
- Prefer usernames in config; numeric ids work but the diff keys by username.
- `memberRoleId` (Ultimate) pairs a custom role with the base access level.

## protected-branches

Branch protections on **project** nodes. Config slice: `protectedBranches[]`,
keyed by `name` (branch name or glob).

- Read: `GET /projects/:id/protected_branches` (paginated).
- Apply: `POST` on create; update is DELETE then POST (GitLab can't repatch
  access levels in place); `DELETE …/:name` on delete.
- CE access-level model: single numeric push/merge/unprotect levels.
  `codeOwnerApprovalRequired` is Premium; a 403 lands in `failed[]`.

## push-rules

The flagship. GitLab push rules aren't version-controlled and their
inheritance is broken: copied at project creation, never propagated, so a
changed group rule never reaches existing projects. This cycle re-asserts the
declared rules on every declared node, every run.

Both **group** and **project** nodes expose the same sub-resource. Config
slice: `pushRules` (a single object).

- Read: `GET /{groups|projects}/:id/push_rule` — 404 (no rule yet) and 403
  (not Premium) both mean "unmanaged here".
- Apply: `POST` when no rule exists, `PUT` on drift, `DELETE` on delete.
- Premium-gated: a 403 on read is tolerated; a 403 on apply surfaces in
  `failed[]` with the API message.

## ci-variables

CI/CD variables on **group** and **project** nodes. Config slice:
`variables[]`, keyed by `(key, environmentScope)` — the same key with two
scopes is two variables.

- Read: `GET /{groups|projects}/:id/variables` (paginated).
- Apply: `POST` / `PUT` / `DELETE`, addressed by key + environment scope
  filter.
- Values are reconciled fully (variables are readable, unlike webhook
  tokens). A value omitted from config is sourced from `GITLAB_VAR_<KEY>` in
  warden's environment — use that for values you'd rather not commit.

## webhooks

Group and project webhooks. Config slice: `webhooks[]`, keyed by `url` (GitLab
addresses hooks by numeric id; the live id is carried for the apply path but
never diffed).

- Read: `GET /{groups|projects}/:id/hooks` (paginated).
- Apply: `POST …/hooks` on create, `PUT …/hooks/:id` on drift,
  `DELETE …/hooks/:id` on delete.
- The `token` field is write-only: sent on create/update, never read back,
  never diffed.

## baseline

Provisioning: ensures declared subgroups and projects **exist** under a
**group** node. Config slice: `baselines[]`, keyed by child `path`.
Existence-only — create, never update or delete.

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

- `approvalRules[]`, keyed by `name` — `GET/POST/PUT/DELETE
  /projects/:id/approval_rules[/:id]`. `userIds`/`groupIds`/
  `protectedBranchIds` are compared order-insensitively.
- `approvalSettings` (single object) — `GET /projects/:id/approvals` read,
  `POST /projects/:id/approvals` apply.
