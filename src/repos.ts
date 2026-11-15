/**
 * `gitlab-warden repos`: the group's project list in the format
 * `chant workspace check --forge-repos <file>` reads (chant#3168).
 *
 * chant never asks the forge itself. An org workspace (`scope: "org"`) holds
 * one `repo` member per repository, and chant compares those members with
 * this list: a repository the forge lists that no member names is WSP014, a
 * member naming one the forge no longer lists is WSP015. Archived projects
 * are listed with `archived: true`; chant does not ask for them to be
 * declared, and a member naming one is not a drop.
 *
 * On GitLab the org is a group. The list covers every project in the group
 * and its subgroups, since the policy governs nodes at any depth under it,
 * and leaves out projects that other namespaces share with the group.
 *
 * The output shape is shared by the three wardens (chant#5069); only the
 * `forge` value differs.
 */

import { encodeId, type GitLabClient } from "./auth/client.js";
import type { GovernanceConfig } from "./config/types.js";

/** The `forge` value gitlab-warden writes. */
export const FORGE = "gitlab";

/** One repository, as `--forge-repos` reads it. `archived` is present only when true. */
export interface ForgeRepoEntry {
  url: string;
  archived?: true;
}

/** The document `repos` writes. `org` is the group's full path. */
export interface ForgeRepoListFile {
  forge: typeof FORGE;
  org: string;
  repos: ForgeRepoEntry[];
}

/** The fields of GitLab's project object the list reads. */
interface GitLabProject {
  path_with_namespace?: string;
  web_url?: string;
  archived?: boolean;
}

/**
 * Every project of `group` and its subgroups, archived ones included (the
 * endpoint returns both when `archived` is not given). The group is read
 * first: the client's paginator turns a 404 into an empty list, and a group
 * the instance does not have would then read as a group with no projects,
 * which chant would report as every member dropped. Here the 404 throws.
 */
export async function listGroupProjects(client: GitLabClient, group: string): Promise<GitLabProject[]> {
  await client.request("GET", `/groups/${encodeId(group)}`);
  return client.paginate<GitLabProject>(`/groups/${encodeId(group)}/projects?include_subgroups=true&with_shared=false`);
}

/**
 * The project's web URL: GitLab's `web_url`, or, when the instance leaves it
 * out, `<baseUrl>/<path_with_namespace>`. chant compares URLs by host and
 * full path, so a declaration's clone URL (https, ssh or scp-style, with or
 * without `.git`) matches it, subgroups included.
 */
function projectUrl(project: GitLabProject, baseUrl: string): string {
  if (project.web_url) return project.web_url;
  if (!project.path_with_namespace) throw new Error("a project in the list has neither web_url nor path_with_namespace");
  return `${baseUrl.replace(/\/+$/, "")}/${project.path_with_namespace}`;
}

/** The `--forge-repos` document for `group`, sorted by URL so a re-run with no change writes the same bytes. */
export async function forgeRepoList(client: GitLabClient, group: string, baseUrl: string): Promise<ForgeRepoListFile> {
  const repos = (await listGroupProjects(client, group))
    .map((p): ForgeRepoEntry => ({ url: projectUrl(p, baseUrl), ...(p.archived === true ? { archived: true as const } : {}) }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { forge: FORGE, org: group, repos };
}

/** The policy's group nodes, by full path. */
export function policyGroups(config: GovernanceConfig): string[] {
  return Object.entries(config.nodes)
    .filter(([, node]) => node.kind === "group")
    .map(([path]) => path);
}

/**
 * The group `repos` lists: `--group` when given, which must be one of the
 * policy's group nodes, else the policy's only top-level group (a group node
 * no other declared group contains). Throws a message for the CLI's exit 2
 * otherwise.
 */
export function pickGroup(groups: string[], requested: string | undefined): string {
  if (requested !== undefined) {
    if (!groups.includes(requested)) {
      throw new Error(`--group ${requested} is not a group the policy governs (${groups.join(", ") || "none"})`);
    }
    return requested;
  }
  const roots = groups.filter((g) => !groups.some((other) => g.startsWith(`${other}/`)));
  if (roots.length === 1) return roots[0]!;
  if (roots.length === 0) throw new Error("the policy governs no group");
  throw new Error(`the policy governs ${roots.length} top-level groups (${roots.join(", ")}); pick one with --group <path>`);
}
