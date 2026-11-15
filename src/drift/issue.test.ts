/**
 * `reconcile --drift-issue` (INTENTIUS/gitlab-warden#75): the dry run's
 * drift records go to chant's keepDriftIssue through chant's GitLab client,
 * so one issue opens on drift, is left alone while the drift is the same,
 * follows a change, and closes on a clean run. GitLab's issues API is an
 * in-memory fake behind the client's fetch; the reconcile client is mocked.
 */

import { describe, expect, it } from "vitest";
import type { ForgeFetch } from "@intentius/chant/pr-forge";
import { membersCycle } from "../cycles/members.js";
import { makeClient } from "../cycles/_testutil.js";
import { runReconcile } from "../reconcile/runner.js";
import type { GovernanceConfig } from "../config/types.js";
import { driftRecords } from "./reader.js";
import { describeDriftIssue, driftIssueEnvironment, driftIssueForge, driftIssueProject, driftIssueRunUrl, isProjectRef, keepGovernanceDriftIssue, policyRoots } from "./issue.js";

interface FakeIssue {
  iid: number;
  title: string;
  description: string;
  state: "opened" | "closed";
  notes: string[];
}

/** The slice of GitLab's issues API chant's client calls, for one project. */
function fakeGitLab(project: string) {
  const issues: FakeIssue[] = [];
  const requests: string[] = [];
  const root = `https://gitlab.example.com/api/v4/projects/${encodeURIComponent(project)}/issues`;
  const json = (status: number, v: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
  const view = (i: FakeIssue) => ({ iid: i.iid, title: i.title, description: i.description, state: i.state, web_url: `https://gitlab.example.com/${project}/-/issues/${i.iid}`, created_at: "2026-11-14T00:00:00Z", author: { username: "warden-bot" } });
  const fetch: ForgeFetch = async (url, init) => {
    requests.push(`${init.method} ${url.replace(root, "<issues>")}`);
    expect(init.headers["PRIVATE-TOKEN"]).toBe("t0ken");
    const body = init.body ? JSON.parse(init.body) : {};
    if (!url.startsWith(root)) return json(404, { message: "404 Project Not Found" });
    const rest = url.slice(root.length);
    if (init.method === "GET" && rest.startsWith("?")) {
      const page = new URL(url).searchParams.get("page");
      return json(200, page === "1" ? issues.filter((i) => i.state === "opened").map(view) : []);
    }
    if (init.method === "POST" && rest === "") {
      const i: FakeIssue = { iid: issues.length + 1, title: body.title, description: body.description, state: "opened", notes: [] };
      issues.push(i);
      return json(201, view(i));
    }
    const m = /^\/(\d+)(\/notes)?$/.exec(rest);
    const i = m ? issues.find((x) => x.iid === Number(m[1])) : undefined;
    if (!i) return json(404, { message: "404 Not Found" });
    if (init.method === "POST" && m![2]) {
      i.notes.push(body.body);
      return json(201, { id: 1, body: body.body });
    }
    if (init.method === "PUT") {
      if (body.state_event === "close") i.state = "closed";
      if (body.title !== undefined) i.title = body.title;
      if (body.description !== undefined) i.description = body.description;
      return json(200, view(i));
    }
    return json(405, {});
  };
  return { issues, requests, fetch };
}

const config: GovernanceConfig = {
  nodes: { "acme/platform": { kind: "group", owned: true, members: [{ user: "alice", accessLevel: "maintainer" }] } },
};

/** The records a dry run against GitLab with alice at `level` gives. */
async function recordsAt(level: number, extra: Array<{ id: number; username: string; access_level: number }> = []) {
  const client = makeClient({}, { "/groups/acme%2Fplatform/members": [{ id: 1, username: "alice", access_level: level }, ...extra] });
  const result = await runReconcile({ config, client, cycles: [membersCycle], mode: "dry-run" });
  return driftRecords({ member: "governance", observedAt: "2026-11-14T12:00:00.000Z", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred, policy: config });
}

const ENV = "gitlab.example.com/acme/platform";

describe("keepGovernanceDriftIssue", () => {
  const gl = () => fakeGitLab("acme/governance");
  const forgeOf = (f: ReturnType<typeof gl>) =>
    driftIssueForge({ baseUrl: "https://gitlab.example.com/", project: "acme/governance", token: "t0ken", tokenEnv: "GITLAB_TOKEN", runUrl: "https://gitlab.example.com/acme/governance/-/pipelines/7", fetch: f.fetch });

  it("opens one issue on drift, leaves it unchanged on the same drift, updates it when the drift changes, and closes it when clean", async () => {
    const f = gl();
    const forge = forgeOf(f);
    const runUrl = "https://gitlab.example.com/acme/governance/-/pipelines/7";

    const opened = await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(30), runUrl });
    expect(opened).toMatchObject({ action: "opened", number: 1, marker: "<!-- gitlab-warden:drift gitlab.example.com/acme/platform -->" });
    expect(f.issues).toHaveLength(1);
    const issue = f.issues[0];
    expect(issue.title).toBe("Governance drift on gitlab.example.com/acme/platform");
    expect(issue.description.startsWith("<!-- gitlab-warden:drift gitlab.example.com/acme/platform -->")).toBe(true);
    expect(issue.description).toContain("| `member/acme/platform/alice` | drifted | `accessLevel`: declared `40`, live `30` |");
    expect(issue.description).toContain(`Found by ${runUrl}.`);

    // Twice with the same drift: still one issue, not edited.
    const again = await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(30), runUrl: `${runUrl}0` });
    expect(again.action).toBe("unchanged");
    expect(f.issues).toHaveLength(1);
    expect(f.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);

    const changed = await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(30, [{ id: 2, username: "bob", access_level: 30 }]) });
    expect(changed).toMatchObject({ action: "updated", number: 1 });
    expect(f.issues).toHaveLength(1);
    // bob is on GitLab and owned but undeclared: drift for the issue too.
    expect(f.issues[0].description).toContain("| `member/acme/platform/bob` | undeclared |");

    const closed = await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(40) });
    expect(closed).toMatchObject({ action: "closed", number: 1 });
    expect(f.issues[0].state).toBe("closed");
    expect(f.issues[0].notes[0]).toContain("found gitlab.example.com/acme/platform matching, so this issue is closed");
    expect(describeDriftIssue(closed)).toBe("Drift issue: closed #1 https://gitlab.example.com/acme/governance/-/issues/1");

    // Clean again with nothing open: nothing to do.
    expect((await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(40) })).action).toBe("none");
  });

  it("leaves the open issue alone when a cycle errored, since the read proves nothing", async () => {
    const f = gl();
    const forge = forgeOf(f);
    await keepGovernanceDriftIssue(forge, { environment: ENV, records: await recordsAt(30) });
    const client = makeClient();
    client.paginate = async () => {
      throw new Error("GET members returned 500");
    };
    const result = await runReconcile({ config, client, cycles: [membersCycle], mode: "dry-run" });
    const records = driftRecords({ member: "governance", observedAt: "2026-11-14T13:00:00.000Z", changeSets: result.changeSets, errored: result.errored, deferred: result.deferred, policy: config });
    expect(records[0]).toMatchObject({ status: "not-observed" });
    const left = await keepGovernanceDriftIssue(forge, { environment: ENV, records });
    expect(left.action).toBe("left");
    expect(f.issues[0].state).toBe("opened");
  });
});

describe("the drift issue's target and environment", () => {
  it("opens an issue for a declared member GitLab lacks (pending)", async () => {
    const f = fakeGitLab("acme/governance");
    const forge = driftIssueForge({ baseUrl: "https://gitlab.example.com", project: "acme/governance", token: "t0ken", tokenEnv: "GITLAB_TOKEN", fetch: f.fetch });
    const client = makeClient({}, { "/groups/acme%2Fplatform/members": [] });
    const result = await runReconcile({ config, client, cycles: [membersCycle], mode: "dry-run" });
    const records = driftRecords({ member: "governance", observedAt: "2026-11-14T12:00:00.000Z", changeSets: result.changeSets, policy: config });
    expect(records).toEqual([expect.objectContaining({ address: "member/acme/platform/alice", status: "pending" })]);
    expect((await keepGovernanceDriftIssue(forge, { environment: ENV, records })).action).toBe("opened");
  });

  it("reads the project from the flag, else CI_PROJECT_PATH, and the run from CI_PIPELINE_URL", () => {
    expect(driftIssueProject("acme/gov", { CI_PROJECT_PATH: "other/x" })).toBe("acme/gov");
    expect(driftIssueProject(undefined, { CI_PROJECT_PATH: "acme/platform/governance" })).toBe("acme/platform/governance");
    expect(driftIssueProject(undefined, {})).toBeUndefined();
    expect(driftIssueRunUrl({ CI_PIPELINE_URL: "https://gitlab.com/acme/gov/-/pipelines/9" })).toBe("https://gitlab.com/acme/gov/-/pipelines/9");
    expect(driftIssueRunUrl({})).toBeUndefined();
    expect(["acme/gov", "acme/sub/gov", "42"].every(isProjectRef)).toBe(true);
    expect(["gov", "acme/", "/gov", "acme gov/x"].some(isProjectRef)).toBe(false);
  });

  it("names the instance and the policy's top-level paths", () => {
    const policy: GovernanceConfig = {
      nodes: {
        "acme/platform": { kind: "group" },
        "acme/platform/api": { kind: "project" },
        "zeta/solo": { kind: "project" },
        "gitlab.example.com": { kind: "instance" },
      },
    };
    expect(policyRoots(policy)).toEqual(["acme/platform", "zeta/solo"]);
    expect(driftIssueEnvironment("https://GitLab.example.com/", policyRoots(policy))).toBe("gitlab.example.com/acme/platform,zeta/solo");
    expect(policyRoots({ nodes: { "gitlab.example.com": { kind: "instance" } } })).toEqual(["gitlab.example.com"]);
  });
});
