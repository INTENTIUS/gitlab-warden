import { describe, it, expect } from "vitest";
import { createClient, encodeId, GitLabApiError } from "./client.js";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake fetch returning queued Responses and recording each call. */
function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? 200;
    const payload = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(status === 204 ? null : payload, { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createClient.request", () => {
  it("joins the v4 root, sends PRIVATE-TOKEN, parses JSON", async () => {
    const { impl, calls } = fakeFetch([{ body: { id: 7, name: "acme" } }]);
    const client = createClient({ baseUrl: "https://gitlab.example.com/", token: "tok", fetchImpl: impl });
    const got = await client.request<{ id: number }>("GET", "/groups/7");
    expect(got.id).toBe(7);
    expect(calls[0]!.url).toBe("https://gitlab.example.com/api/v4/groups/7");
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe("tok");
  });

  it("defaults the base URL to gitlab.com and serializes a JSON body", async () => {
    const { impl, calls } = fakeFetch([{ body: {} }]);
    const client = createClient({ token: "t", fetchImpl: impl });
    await client.request("POST", "/groups/1/members", { user_id: 9, access_level: 30 });
    expect(calls[0]!.url).toBe("https://gitlab.com/api/v4/groups/1/members");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ user_id: 9, access_level: 30 });
  });

  it("204 / empty body → {}", async () => {
    const { impl } = fakeFetch([{ status: 204 }]);
    const client = createClient({ token: "t", fetchImpl: impl });
    expect(await client.request("DELETE", "/groups/1/members/9")).toEqual({});
  });

  it("surfaces the status code in the error", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { message: "insufficient_scope" } }]);
    const client = createClient({ token: "t", fetchImpl: impl });
    await expect(client.request("GET", "/projects/1/push_rule")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(client.request("GET", "/x")).rejects.toBeInstanceOf(GitLabApiError);
  });
});

describe("createClient.paginate", () => {
  it("follows X-Next-Page until exhausted", async () => {
    const { impl, calls } = fakeFetch([
      { body: [{ id: 1 }, { id: 2 }], headers: { "x-next-page": "2" } },
      { body: [{ id: 3 }], headers: { "x-next-page": "" } },
    ]);
    const client = createClient({ token: "t", fetchImpl: impl });
    const all = await client.paginate<{ id: number }>("/groups/1/members");
    expect(all.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(calls[0]!.url).toContain("per_page=100&page=1");
    expect(calls[1]!.url).toContain("page=2");
  });

  it("appends pagination params with & when the path already has a query", async () => {
    const { impl, calls } = fakeFetch([{ body: [], headers: {} }]);
    const client = createClient({ token: "t", fetchImpl: impl });
    await client.paginate("/projects/1/variables?filter[environment_scope]=*");
    expect(calls[0]!.url).toContain("scope]=*&per_page=100");
  });

  it("404 → empty list", async () => {
    const { impl } = fakeFetch([{ status: 404, body: { message: "404 Not Found" } }]);
    const client = createClient({ token: "t", fetchImpl: impl });
    expect(await client.paginate("/groups/999/members")).toEqual([]);
  });
});

describe("encodeId", () => {
  it("URL-encodes full paths", () => {
    expect(encodeId("acme/platform/api")).toBe("acme%2Fplatform%2Fapi");
    expect(encodeId(42)).toBe("42");
  });
});
