# Policy

The policy is the foundation of this tool: one YAML file with a single top-level
`nodes:` map that declares desired state for the GitLab groups, projects, and
(optionally) the self-managed instance you govern. Everything else (the CLI, the
cycles, the guardrails) serves the policy. It is the one file you must author.

- Loaded via `--config governance.yaml` (YAML, or JSON if the path ends in `.json`).
- Schema (authoritative): `src/config/types.ts`.
- A **node** is one declared group or project (or the instance), keyed by full
  path (`acme/platform` is a group, `acme/platform/api` a project). Each node
  becomes one reconcile scope with a kind-prefixed id (`group:acme/platform`).
- warden manages exactly the declared nodes. It never auto-walks
  `descendant_groups` to claim the rest of the tree (see [DESIGN.md](DESIGN.md) §1).
- Selective-by-omission: an absent field or collection is never read for
  mutation, diffed, or changed. This holds at two levels: which nodes you
  declare, and which fields/collections within a node you declare.

Three behaviors worth knowing before you write one:

- **Deletes are opt-in, per node.** Deletes are ownership-gated: the diff
  proposes deleting a live entry missing from the policy only when that
  entry's collection is marked owned, and by default nothing is owned — a
  node's plans contain **creates and updates only**, so a live member,
  webhook, or variable you did not declare is left alone. Declaring
  `owned: true` on a node makes warden own every resource collection it
  reconciles there; a list such as `owned: [member, webhook]` limits
  ownership to the listed resource types (the `[type]` labels shown in
  plans). A programmatic `diffOptions.isOwned` predicate, when supplied,
  overrides the declaration. Owned deletes still run a guardrail before
  any apply — the per-collection removal cap (chant's `removalDeltaCap`):
  within one apply, each resource type's deletes may not exceed 25% (or
  `--removal-cap-fraction`) of that type's live entries in the collections
  this node's policy declares. The denominator is per type, so live
  entries of one kind (members, say) never dilute the delete fraction of
  another (webhooks); a type the diff has no live count for is measured
  against that type's own non-create plan entries instead. A converged
  node's single stale delete passes (1 of N live), while a typo that would
  drop most of one collection blocks, and the block message names the
  worst-offending type. The cap bounds a single apply, not history —
  repeated applies can remove more over time, and it measures only the
  collections the policy declares. A node rename declared with
  `previously:` is a single update and never counts as a delete.
- **Renames are explicit, not inferred.** Changing a declared node's key
  would otherwise read as "old node gone, new node missing", and for a node
  that means losing the project's history or the group's memberships to a
  delete + create. Declaring the former path as `previously:` on the node
  turns that into an explicit rename: when the live group/project still sits
  at the old path (and nothing sits at the new one), warden adopts it there
  and plans one in-place update (`PUT /groups/:id` / `PUT /projects/:id` with
  the new path) that keeps the id, history, and memberships. Since nothing is
  deleted, no `owned` is needed. While the rename is pending, the node's
  scope runs under its old path (the live identity) and the rename applies
  after the other cycles; the next run finds the node at its declared path
  and the alias goes inert, so it is safe to leave in place. The alias must
  share the declared path's parent namespace (a namespace move is a transfer,
  which is a different API and out of scope). The rename PUT sends the
  `path` alone, so a hand-curated display name survives; only a group whose
  policy manages the name (`groupSettings.name`) gets that managed value
  sent alongside. One limitation: a pending group rename with declared
  descendant nodes takes two runs — this run's descendant scopes are
  addressed by their declared paths, which only exist once the rename
  (applied last) lands, so the run flags the sequence with a NOTE; apply the
  rename, then run again for the descendants. Webhooks support the same
  `previously:` (former URL, keeping the hook id). Protected branches
  deliberately do not: they are keyed by name with no in-place rename API, so
  a renamed protection is honestly a delete + create.
- **Tier-graceful.** Premium/Ultimate endpoints that return 403 on read are
  tolerated and skipped, never fatal: the cycle's plan gains a
  `NOTE: <slice>: read was tier-gated (403); planned entries may fail on apply`
  line, a slice you declared anyway plans as a create, and its apply lands the
  403 in that cycle's `failed[]`. Slices below are marked with the tier they
  need; everything unmarked works on Free/CE.

## Access levels

Config accepts either the name or the raw GitLab number anywhere an access
level appears (see `src/config/access-levels.ts` and the
[design doc](DESIGN.md) §2):

| Name | Number |
|---|---|
| `no_access` | 0 |
| `minimal` | 5 |
| `guest` | 10 |
| `planner` | 15 |
| `reporter` | 20 |
| `developer` | 30 |
| `maintainer` | 40 |
| `owner` | 50 |

Protected-branch/tag/environment access levels are plain numbers in config
(the CE model: a single numeric level per action).

## A complete policy

Copy this, delete what you don't need, and edit it. Every field from
`src/config/types.ts` is shown. Comments name the cycle that consumes each
slice and mark tier requirements.

```yaml
# governance.yaml — one top-level key: nodes, a map keyed by full path.
nodes:

  # ========== a group node ==========
  acme/platform:
    kind: group

    owned: [member, webhook]            # delete gate (optional; default: no deletes).
                                        #   true → warden owns every collection it
                                        #   reconciles here; a list owns only those
                                        #   resource types (the [type] labels in plans);
                                        #   absent/false → creates and updates only

    groupSettings:                      # cycle: group-settings
      name: Platform
      description: "Platform engineering"
      visibility: private               # private | internal | public
      requestAccessEnabled: false
      projectCreationLevel: maintainer  # noone | maintainer | developer
      subgroupCreationLevel: owner      # owner | maintainer
      preventForkingOutsideGroup: true
      mentionsDisabled: false

    members:                            # cycle: members — DIRECT members only
      - user: alice                     # username (preferred) or numeric id
        accessLevel: owner              # name or number
        expiresAt: "2027-01-01"
      - user: bob
        accessLevel: developer
        memberRoleId: 12                # custom role id — Ultimate

    pushRules:                          # cycle: push-rules — Premium (the flagship)
      commitMessageRegex: "^(feat|fix|chore):"
      commitMessageNegativeRegex: "wip"
      branchNameRegex: "^(main|release/.*|[a-z0-9-]+)$"
      authorEmailRegex: "@example\\.com$"
      fileNameRegex: "\\.(exe|dll)$"
      maxFileSize: 50                   # MB
      preventSecrets: true
      memberCheck: true
      rejectUnsignedCommits: false
      rejectNonDcoCommits: false

    variables:                          # cycle: ci-variables — keyed by (key, environmentScope)
      - key: DEPLOY_REGION
        value: eu-west-1
        environmentScope: "*"
        protected: true
        masked: false
        variableType: env_var           # env_var | file
      - key: REGISTRY_PASSWORD          # value omitted → read from $GITLAB_VAR_REGISTRY_PASSWORD
        masked: true

    webhooks:                           # cycle: webhooks — keyed by url
      - url: https://ci.example.com/hook
        pushEvents: true
        mergeRequestsEvents: true
        tagPushEvents: false
        issuesEvents: false
        pipelineEvents: true
        enableSslVerification: true
        token: "s3cret"                 # write-only; never read back, so never diffed

    integrations:                       # cycle: integrations — keyed by integration slug
      - name: slack
        active: true
        properties:                     # write-only (GitLab masks them); re-applied on change
          webhook: https://hooks.slack.com/services/T000/B000/XXXX

    deployTokens:                       # cycle: deploy-keys-tokens — immutable, presence-only
      - name: registry-read
        scopes: [read_registry]
        expiresAt: "2026-12-31"
        username: registry-bot

    accessTokens:                       # cycle: access-tokens — immutable, presence-only
      - name: ci-bot
        scopes: [api]
        accessLevel: maintainer
        expiresAt: "2026-12-31"

    protectedEnvironments:              # cycle: protected-environments — Premium
      - name: production
        deployAccessLevels: [40]        # numeric levels allowed to deploy
        requiredApprovalCount: 1

    memberRoles:                        # cycle: member-roles — Ultimate
      - name: auditor
        baseAccessLevel: reporter
        permissions: [read_code]

    complianceFrameworks:               # cycle: compliance-frameworks — Premium/Ultimate,
      - name: SOC2                      #   GraphQL, top-level groups
        description: "SOC 2 controls"
        color: "#1aaa55"
        pipelineConfigurationFullPath: "compliance.yml@acme/compliance"

    securityPolicy:                     # cycle: security-policies — Ultimate, GraphQL
      policyProject: acme/security-policies   # empty/unset → unlink

    baselines:                          # cycle: baseline — existence only (group nodes)
      - kind: group
        path: infra
        name: Infrastructure
        visibility: private
      - kind: project
        path: api
        template: rails                 # project template to generate from (projects only)

  # ========== a project node ==========
  acme/platform/api:
    kind: project

    previously: acme/platform/api-svc   # former full path: turns a rename into an
                                        # update instead of a delete + create (also
                                        # valid on group nodes; same parent only)

    projectSettings:                    # cycle: project-settings
      description: "Platform API"
      visibility: private
      defaultBranch: main
      mergeMethod: ff                   # merge | rebase_merge | ff
      squashOption: default_on          # never | always | default_on | default_off
      onlyAllowMergeIfPipelineSucceeds: true
      onlyAllowMergeIfAllDiscussionsAreResolved: true
      removeSourceBranchAfterMerge: true
      topics: [go, service]

    members:                            # same shape as on groups; direct members only
      - user: carol
        accessLevel: maintainer

    protectedBranches:                  # cycle: protected-branches — project nodes only
      - name: main                      # branch name or glob (the identity key)
        pushAccessLevel: 40             # numeric (CE model)
        mergeAccessLevel: 30
        unprotectAccessLevel: 40
        allowForcePush: false
        codeOwnerApprovalRequired: true # Premium; a 403 on apply lands in failed[]

    protectedTags:                      # cycle: protected-tags — project nodes only
      - name: "v*"
        createAccessLevel: 40

    deployKeys:                         # cycle: deploy-keys-tokens — project nodes only
      - title: deploy-ci                # identity key
        key: "ssh-ed25519 AAAA…"        # set on create; canPush is the only mutable field
        canPush: false

    jobTokenScope:                      # cycle: advanced-protections — project nodes only
      inboundEnabled: true              # require allowlisting to use this project's job token

    approvalRules:                      # cycle: mr-approvals — Premium
      - name: security                  # identity key
        approvalsRequired: 2
        userIds: [42]
        groupIds: [7]
        protectedBranchIds: [3]

    approvalSettings:                   # cycle: mr-approvals — Premium
      resetApprovalsOnPush: true
      disableOverridingApproversPerMergeRequest: true
      mergeRequestsAuthorApproval: false
      mergeRequestsDisableCommittersApproval: true
      requirePasswordToApprove: false

    pipelineSchedules:                  # cycle: pipeline-schedules — project nodes only
      - description: nightly-build      # identity key; unique per project
        cron: "0 2 * * *"
        cronTimezone: UTC
        ref: main                       # short name; refs/heads/… also converges
        active: true
        variables:                      # reconciled by key within the schedule
          - key: SCHEDULE_KIND
            value: nightly
            variableType: env_var       # env_var | file

    # pushRules, variables, webhooks, integrations, deployTokens, accessTokens,
    # protectedEnvironments, and securityPolicy are valid on project nodes too,
    # with the same shapes as shown on the group node above.

  # ========== an instance node (self-managed only; needs an admin token) ==========
  # The map key for an instance node is a label of your choosing — instance
  # endpoints are fixed paths, so the key is not used to address the API.
  gitlab.example.com:
    kind: instance

    instanceSettings:                   # cycle: instance-governance — generic passthrough
      signup_enabled: false             #   of GET/PUT /application/settings keys, verbatim
      default_project_visibility: private

    systemHooks:                        # cycle: instance-governance — same shape as webhooks
      - url: https://audit.example.com/hook
        pushEvents: true
        enableSslVerification: true

    instanceVariables:                  # cycle: instance-governance — same shape as variables
      - key: ORG_NAME
        value: acme

    memberRoles:                        # cycle: member-roles — instance-level roles (Ultimate)
      - name: incident-responder
        baseAccessLevel: developer
        permissions: [admin_merge_request]
```

The smallest valid node is just `kind:`, which manages nothing. The smallest
useful policy is one node with one slice, such as a group with `pushRules`.

## Which slices apply to which node kinds

| Slice | group | project | instance |
|---|---|---|---|
| `groupSettings` | yes | — | — |
| `projectSettings` | — | yes | — |
| `members` | yes | yes | — |
| `protectedBranches` | — | yes | — |
| `protectedTags` | — | yes | — |
| `protectedEnvironments` | yes | yes | — |
| `deployKeys` | — | yes | — |
| `deployTokens` | yes | yes | — |
| `accessTokens` | yes | yes | — |
| `pushRules` | yes | yes | — |
| `jobTokenScope` | — | yes | — |
| `memberRoles` | yes | — | yes |
| `complianceFrameworks` | yes (top-level) | — | — |
| `securityPolicy` | yes | yes | — |
| `approvalRules` / `approvalSettings` | — | yes | — |
| `variables` | yes | yes | — |
| `pipelineSchedules` | — | yes | — |
| `webhooks` | yes | yes | — |
| `integrations` | yes | yes | — |
| `baselines` | yes | — | — |
| `instanceSettings` / `systemHooks` / `instanceVariables` | — | — | yes |

A slice declared on a node kind its cycle doesn't cover is ignored (the cycle
no-ops on that kind).

## Field reference

Types below are the config shapes; "key" names the identity field the diff
uses to match config entries against live entries. Tier "Free" means CE works.

The top-level map is **`nodes{}`**. Its key is the full path of the
group/project (a label for instance nodes), and each value is one node:

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `kind` | `group` \| `project` \| `instance` | **required** | all | Free | selects which endpoints every cycle uses for this node |
| `owned` | boolean \| string[] | optional; default: no deletes | all | Free | delete gate for this node's collections: `true` = warden owns everything it reconciles here (live entries absent from config become deletes); a list owns only those resource types (the `[type]` labels in plans — `member`, `webhook`, `variable`, …; the full vocabulary is `RESOURCE_TYPE_ORDER` in `src/reconcile/diff.ts`); absent/`false` = creates and updates only |
| `previously` | string | optional | node-rename (runner-managed) | Free | former full path — an explicit rename intent, no `owned` needed: when the live group/project exists at the old path (and none at the declared path), the plan is a single update that keeps the id, history, and memberships. Must share the declared path's parent namespace; not valid on instance nodes |

Group settings live in **`groupSettings`**, a partial update of
`PUT /groups/:id`.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | optional | group-settings | Free | display name |
| `description` | string | optional | group-settings | Free | group description |
| `visibility` | `private` \| `internal` \| `public` | optional | group-settings | Free | group visibility |
| `requestAccessEnabled` | boolean | optional | group-settings | Free | allow users to request access |
| `projectCreationLevel` | `noone` \| `maintainer` \| `developer` | optional | group-settings | Free | who may create projects in the group |
| `subgroupCreationLevel` | `owner` \| `maintainer` | optional | group-settings | Free | who may create subgroups |
| `preventForkingOutsideGroup` | boolean | optional | group-settings | Premium | forbid forks outside the group |
| `mentionsDisabled` | boolean | optional | group-settings | Free | disable group mentions |

Project settings follow the same pattern in **`projectSettings`**, a
partial `PUT /projects/:id`.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `description` | string | optional | project-settings | Free | project description |
| `visibility` | `private` \| `internal` \| `public` | optional | project-settings | Free | project visibility |
| `defaultBranch` | string | optional | project-settings | Free | default branch name |
| `mergeMethod` | `merge` \| `rebase_merge` \| `ff` | optional | project-settings | Free | merge strategy |
| `squashOption` | `never` \| `always` \| `default_on` \| `default_off` | optional | project-settings | Free | squash-on-merge behavior |
| `onlyAllowMergeIfPipelineSucceeds` | boolean | optional | project-settings | Free | require a green pipeline to merge |
| `onlyAllowMergeIfAllDiscussionsAreResolved` | boolean | optional | project-settings | Free | require resolved discussions to merge |
| `removeSourceBranchAfterMerge` | boolean | optional | project-settings | Free | default the delete-source-branch checkbox on |
| `topics` | string[] | optional | project-settings | Free | project topics (compared order-insensitively) |

A **`members[]`** list declares the direct members of a group or project;
the diff never treats an inherited member as drift (see the
[design doc](DESIGN.md) §2).

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `user` | string \| number | **required** (key) | members | Free | username (preferred; the diff keys by username) or numeric user id |
| `accessLevel` | name \| number | **required** | members | Free | role at this node; drift is an update, not delete+create |
| `memberRoleId` | number | optional | members | Ultimate | custom member role id, pairs with the base `accessLevel` |
| `expiresAt` | string (date) | optional | members | Free | membership expiry; sent on create |

Each **`protectedBranches[]`** entry protects one branch on a project.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | protected-branches | Free | branch name or glob |
| `pushAccessLevel` | number | optional | protected-branches | Free | minimum level allowed to push |
| `mergeAccessLevel` | number | optional | protected-branches | Free | minimum level allowed to merge |
| `unprotectAccessLevel` | number | optional | protected-branches | Free | minimum level allowed to unprotect |
| `allowForcePush` | boolean | optional | protected-branches | Free | permit force-push to the protected branch |
| `codeOwnerApprovalRequired` | boolean | optional | protected-branches | Premium | require CODEOWNERS approval (403 on apply lands in `failed[]`) |

With **`protectedTags[]`**, a project protects tag names or globs.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | protected-tags | Free | tag name or glob |
| `createAccessLevel` | number | optional | protected-tags | Free | minimum level allowed to create the tag |

Groups and projects both accept **`protectedEnvironments[]`**.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | protected-environments | Premium | environment name |
| `deployAccessLevels` | number[] | optional | protected-environments | Premium | levels allowed to deploy (compared order-insensitively) |
| `requiredApprovalCount` | number | optional | protected-environments | Premium | required deployment approvals |

Only projects carry **`deployKeys[]`**.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `title` | string | **required** (key) | deploy-keys-tokens | Free | key title |
| `key` | string | **required** | deploy-keys-tokens | Free | public key, set on create (write-only) |
| `canPush` | boolean | optional | deploy-keys-tokens | Free | the only mutable field (updated in place) |

Deploy tokens under **`deployTokens[]`** are immutable and reconciled by
presence on groups and projects.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | deploy-keys-tokens | Free | token name |
| `scopes` | string[] | optional | deploy-keys-tokens | Free | e.g. `read_repository`, `read_registry` |
| `expiresAt` | string (date) | optional | deploy-keys-tokens | Free | expiry, sent on create |
| `username` | string | optional | deploy-keys-tokens | Free | custom username, sent on create |

Bot credentials in **`accessTokens[]`** are likewise create-and-revoke only;
the secret is returned on create and never again.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | access-tokens | Free* | token (bot) name |
| `scopes` | string[] | optional | access-tokens | Free* | e.g. `api`, `read_api` |
| `accessLevel` | name \| number | optional | access-tokens | Free* | bot's role |
| `expiresAt` | string (date) | optional | access-tokens | Free* | expiry, sent on create |

\* Project access tokens work on Free self-managed; on GitLab.com,
group/project access tokens require a paid namespace.

Push rules in **`pushRules`** are the flagship for groups and projects alike
(see the [cycle catalog](CYCLES.md)).

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `commitMessageRegex` | string | optional | push-rules | Premium | commit messages must match |
| `commitMessageNegativeRegex` | string | optional | push-rules | Premium | commit messages must NOT match |
| `branchNameRegex` | string | optional | push-rules | Premium | branch names must match |
| `authorEmailRegex` | string | optional | push-rules | Premium | author email must match |
| `fileNameRegex` | string | optional | push-rules | Premium | reject files whose names match |
| `maxFileSize` | number (MB) | optional | push-rules | Premium | reject files larger than this |
| `preventSecrets` | boolean | optional | push-rules | Premium | reject likely-secret files |
| `memberCheck` | boolean | optional | push-rules | Premium | commit author must be a GitLab user |
| `rejectUnsignedCommits` | boolean | optional | push-rules | Premium | require signed commits |
| `rejectNonDcoCommits` | boolean | optional | push-rules | Premium | require DCO sign-off |

A project's **`jobTokenScope`** hardens its CI job token.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `inboundEnabled` | boolean | optional | advanced-protections | Free | require other projects to be allowlisted before they can use this project's CI job token |

Custom roles in **`memberRoles[]`** are presence-only and matched by name on
group and instance nodes.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | member-roles | Ultimate | role name |
| `baseAccessLevel` | name \| number | **required** | member-roles | Ultimate | base role the custom role extends |
| `permissions` | string[] | optional | member-roles | Ultimate | fine-grained permissions, e.g. `read_code`, `admin_merge_request` |

Compliance definitions in **`complianceFrameworks[]`** live on top-level
groups and go through GraphQL as a best-effort surface (unvalidated against a
live Ultimate instance; the hermetic e2e runs CE).

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | compliance-frameworks | Premium/Ultimate | framework name |
| `description` | string | optional | compliance-frameworks | Premium/Ultimate | framework description |
| `color` | string (hex) | optional | compliance-frameworks | Premium/Ultimate | label color, e.g. `#1aaa55` |
| `pipelineConfigurationFullPath` | string | optional | compliance-frameworks | Ultimate | enforced pipeline config, `file@group/project` |

The **`securityPolicy`** link on groups and projects also rides GraphQL, with
the same caveat about live Ultimate validation.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `policyProject` | string | optional | security-policies | Ultimate | full path of the linked security policy project; empty/unset → unlink. The policy *content* lives in that project and is not reconciled here. |

Approval rules in **`approvalRules[]`** belong to projects.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | mr-approvals | Premium | rule name |
| `approvalsRequired` | number | optional | mr-approvals | Premium | approvals the rule demands |
| `userIds` | number[] | optional | mr-approvals | Premium | eligible approver user ids (order-insensitive) |
| `groupIds` | number[] | optional | mr-approvals | Premium | eligible approver group ids (order-insensitive) |
| `protectedBranchIds` | number[] | optional | mr-approvals | Premium | protected branches the rule applies to (order-insensitive) |

So does the single **`approvalSettings`** object, applied via
`POST /projects/:id/approvals`.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `resetApprovalsOnPush` | boolean | optional | mr-approvals | Premium | new commits reset approvals |
| `disableOverridingApproversPerMergeRequest` | boolean | optional | mr-approvals | Premium | forbid per-MR approver edits |
| `mergeRequestsAuthorApproval` | boolean | optional | mr-approvals | Premium | allow authors to approve their own MR |
| `mergeRequestsDisableCommittersApproval` | boolean | optional | mr-approvals | Premium | forbid committers approving |
| `requirePasswordToApprove` | boolean | optional | mr-approvals | Premium | re-authenticate to approve |

CI variables in **`variables[]`** are identified by `key` plus
`environmentScope` on groups and projects.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `key` | string | **required** (key) | ci-variables | Free | variable name |
| `value` | string | optional; falls back to `$GITLAB_VAR_<KEY>` | ci-variables | Free | value; keep secrets out of config by exporting `GITLAB_VAR_<KEY>` instead — an env-sourced value is diffed and drift-corrected like a committed one. With neither, the value isn't diffed (presence-only) and a create writes `""` |
| `environmentScope` | string | optional (`*` in the diff key when unset) | ci-variables | Free (scoping: Premium) | environment scope; part of the identity key |
| `protected` | boolean | optional | ci-variables | Free | only exposed to protected branches/tags |
| `masked` | boolean | optional | ci-variables | Free | masked in job logs |
| `variableType` | `env_var` \| `file` | optional | ci-variables | Free | how the runner materializes it |

Schedules in **`pipelineSchedules[]`** belong to projects and are matched
by `description` (GitLab gives them no natural key, so renaming a
description is a delete + create). Warden writes need schedule ownership;
GitLab 403s a write to another user's schedule, and the apply error names
the `take_ownership` remediation (see the [cycle catalog](CYCLES.md)).

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `description` | string | **required** (key) | pipeline-schedules | Free | schedule identity, unique per project (duplicate live descriptions are flagged with a plan NOTE) |
| `cron` | string | **required** | pipeline-schedules | Free | cron expression, e.g. `0 2 * * *` |
| `cronTimezone` | string | optional (GitLab default UTC) | pipeline-schedules | Free | timezone for the cron |
| `ref` | string | **required** | pipeline-schedules | Free | branch or tag the scheduled pipeline runs on; `refs/heads/…` and the short name converge either way |
| `active` | boolean | optional (GitLab default true) | pipeline-schedules | Free | whether the schedule fires |
| `variables` | list | optional | pipeline-schedules | Free | variables injected into the scheduled pipeline (`key` + `value`, optional `variableType`), reconciled by key; a live variable you did not declare is deleted only when the node owns `pipeline-schedule` |

Hooks in **`webhooks[]`** are matched by `url`; group webhooks are a Premium
feature while project webhooks are Free.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `url` | string | **required** (key) | webhooks | Free | hook endpoint |
| `previously` | string | optional | webhooks | Free | former hook URL — an explicit rename intent, no `owned` needed: when a live hook by the old URL exists (and none by the new URL), the plan is a single update that keeps the hook id. Ignored on `systemHooks` (no update endpoint there) |
| `pushEvents` | boolean | optional | webhooks | Free | trigger on pushes |
| `mergeRequestsEvents` | boolean | optional | webhooks | Free | trigger on MR events |
| `tagPushEvents` | boolean | optional | webhooks | Free | trigger on tag pushes |
| `issuesEvents` | boolean | optional | webhooks | Free | trigger on issue events |
| `pipelineEvents` | boolean | optional | webhooks | Free | trigger on pipeline events |
| `enableSslVerification` | boolean | optional | webhooks | Free | verify TLS on delivery |
| `token` | string | optional | webhooks | Free | write-only secret; never read back, so never diffed |

Entries in **`integrations[]`** are matched by the integration slug, such as
`slack` or `jira`.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `name` | string | **required** (key) | integrations | Free | GitLab integration slug |
| `active` | boolean | optional | integrations | Free | enabled state. `active: false` declares the integration OFF: warden plans a deactivate via GitLab's DELETE path (the PUT upsert would (re)activate), with no `owned` needed — it is explicit declared intent, not an undeclared-entry prune |
| `properties` | map | optional | integrations | Free | integration settings; write-only (GitLab masks them), so property-only drift isn't detected — they are re-applied on every create/update |

Children under **`baselines[]`** are provisioned by existence only, on
groups.

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| `kind` | `group` \| `project` | **required** | baseline | Free | what to create under this group |
| `path` | string | **required** (key) | baseline | Free | path segment of the child |
| `name` | string | default: `path` | baseline | Free | display name on create |
| `visibility` | `private` \| `internal` \| `public` | optional | baseline | Free | visibility on create |
| `template` | string | optional | baseline | Free/Premium | project template name to generate from (projects only; custom group templates are Premium) |

Once a child exists, its settings are the settings cycles' concern; declare
the child as its own node to manage it.

Instance-wide settings go in **`instanceSettings`** (self-managed only;
requires an admin token).

| Field | Type | Required / default | Cycle | Tier | Meaning |
|---|---|---|---|---|---|
| *(any key)* | any | optional | instance-governance | Free (self-managed) | generic passthrough: each key is compared against `GET /application/settings` and applied via `PUT` verbatim, snake_case as GitLab names it (e.g. `signup_enabled`) |

System hooks in **`systemHooks[]`** share the `webhooks[]` shape, though the
system-hooks API only carries `url`, `pushEvents`, `tagPushEvents`,
`mergeRequestsEvents`, `enableSslVerification`, and `token` (leave the other
event flags unset on instance nodes). They are reconciled against
`GET/POST/DELETE /hooks`; no update endpoint exists, so drift is fixed by
delete + re-create.

Instance variables in **`instanceVariables[]`** look like `variables[]`
without a meaningful `environmentScope`, and they live at
`/admin/ci/variables`.

## What a reconcile does with this file

For every declared node and every selected cycle, warden fetches live state
and builds the desired slice. It then diffs the two (selective-by-omission,
with ownership-gated deletes) and checks guardrails. `--mode dry-run`, the
default, prints the plan; `--mode apply` executes it. See the
[CLI reference](CLI.md) for flags and the [cycle catalog](CYCLES.md) for what
each cycle touches.
