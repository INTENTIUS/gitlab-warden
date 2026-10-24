/**
 * The graph reader for a forge-governance member (INTENTIUS/chant#4413,
 * #3180): the governance YAML as graph IR. It reads the document and nothing
 * else, so it takes no GitLab call and writes nothing, and it draws the policy
 * as declared.
 *
 * GitLab's words map onto the kind's: a group is a team and a project is a
 * repo, as the kind's `teams` and `repos` outputs have it. A node is an org
 * (the top-level namespace a declared path sits under), a team (group), a repo
 * (project), a branch protection rule (a project's `protectedBranches` entry)
 * or an app (an `integrations` entry on a group or project). A group has
 * access to the projects below it, so an edge runs from the nearest declared
 * group above a project to the project, and from a group to the nearest
 * declared group above it. GitLab has push rules, not rulesets, so there are
 * no ruleset nodes.
 */

type Obj = Record<string, unknown>;

export interface IRNode {
  id: string;
  kind: string;
  lexicon: string;
  attrs: Record<string, unknown>;
  sourceLoc?: { file: string };
}
export interface IREdge {
  from: string;
  to: string;
  kind: "ref";
  viaAttr?: string;
}
export interface GraphIR {
  nodes: IRNode[];
  edges: IREdge[];
  groups: { byLexicon: Record<string, string[]>; byStack: Record<string, string[]> };
}

const LEXICON = "gitlab-warden";

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** The attributes of `from` that are set, so a node carries what the policy states and no more. */
function pick(from: Obj, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

export function readGovernance(doc: unknown, file?: string): GraphIR {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const byStack: Record<string, string[]> = {};
  const sourceLoc = file ? { sourceLoc: { file } } : {};
  const declared = isObj(doc) && isObj(doc.nodes) ? doc.nodes : {};
  const entries = Object.entries(declared).filter((e): e is [string, Obj] => isObj(e[1]) && (e[1].kind === "group" || e[1].kind === "project"));
  const groupPaths = new Set(entries.filter(([, n]) => n.kind === "group").map(([p]) => p));

  const add = (stack: string, id: string, kind: string, attrs: Record<string, unknown>) => {
    if (nodes.some((n) => n.id === id)) return;
    nodes.push({ id, kind, lexicon: LEXICON, attrs, ...sourceLoc });
    (byStack[stack] ??= []).push(id);
  };
  /** The nearest declared group above `path`, if any. */
  const parentGroup = (path: string): string | undefined => {
    for (let p = path.split("/").slice(0, -1); p.length > 0; p = p.slice(0, -1)) {
      if (groupPaths.has(p.join("/"))) return p.join("/");
    }
    return undefined;
  };

  for (const [path, node] of entries) {
    const top = path.split("/")[0];
    add(top, `org/${top}`, "Org", { name: top });
    const group = node.kind === "group";
    const id = `${group ? "team" : "repo"}/${path}`;
    const settingsKey = group ? "groupSettings" : "projectSettings";
    const settings = isObj(node[settingsKey]) ? (node[settingsKey] as Obj) : {};
    add(top, id, group ? "Team" : "Repo", {
      path,
      ...pick(settings, group ? ["visibility", "description"] : ["visibility", "defaultBranch", "mergeMethod", "topics"]),
      memberCount: objs(node.members).length,
    });
    const parent = parentGroup(path);
    if (parent) edges.push({ from: `team/${parent}`, to: id, kind: "ref", viaAttr: group ? "namespace" : "access:namespace" });

    if (!group) {
      for (const pb of objs(node.protectedBranches)) {
        if (typeof pb.name !== "string") continue;
        const pid = `protection/${path}/${pb.name}`;
        add(top, pid, "BranchProtection", { name: pb.name, ...pick(pb, ["pushAccessLevel", "mergeAccessLevel", "allowForcePush", "codeOwnerApprovalRequired"]) });
        edges.push({ from: pid, to: id, kind: "ref", viaAttr: "protectedBranches" });
      }
    }
    for (const app of objs(node.integrations)) {
      if (typeof app.name !== "string") continue;
      const aid = `app/${path}/${app.name}`;
      add(top, aid, "App", { name: app.name, ...pick(app, ["active"]) });
      edges.push({ from: aid, to: id, kind: "ref", viaAttr: "integration" });
    }
  }

  return { nodes, edges, groups: { byLexicon: { [LEXICON]: nodes.map((n) => n.id) }, byStack } };
}
