/**
 * GitLab REST client (API v4).
 *
 * A thin authed wrapper over a GitLab instance's REST API. Host-parameterized
 * (GitLab.com or self-managed) and token-authed — no Apps. The
 * `request(method, path, body)` signature is intentionally identical to the
 * github/forgejo warden clients so the shared `Cycle` interface and cycle code
 * stay portable across wardens.
 *
 *   path is relative to the API root: `request("GET", "/groups/123")` resolves
 *   to `<baseUrl>/api/v4/groups/123`. An absolute `http(s)://…` path is used
 *   as-is. Group/project ids that are full paths must be URL-encoded by the
 *   caller — use `encodeId()` (e.g. `encodeId("acme/platform/api")`).
 *
 * `paginate()` follows GitLab's `X-Next-Page` header (offset pagination,
 * per_page=100) — sufficient for governance-sized collections; a 404 yields an
 * empty list.
 */

const API_PATH = "/api/v4";
const DEFAULT_BASE_URL = "https://gitlab.com";
const USER_AGENT = "gitlab-warden (+https://github.com/INTENTIUS/gitlab-warden)";

/** Error from a GitLab API request. The message embeds the status code so cycles
 *  can branch on it (e.g. tolerate 403 on tier-gated endpoints, 404 on absent). */
export class GitLabApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export interface GitLabClientOptions {
  /** Instance base URL. Default "https://gitlab.com". Self-managed: "https://gitlab.example.com". */
  baseUrl?: string;
  /** API token (PAT or group/project access token). Sent as `PRIVATE-TOKEN`. */
  token: string;
  /** Injectable fetch for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GitLabClient {
  /** Authed request; `path` is relative to `<baseUrl>/api/v4`. Returns parsed JSON. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Collect every page of a list endpoint (follows `X-Next-Page`). 404 → []. */
  paginate<T = unknown>(path: string, perPage?: number): Promise<T[]>;
  /** Execute a GraphQL query/mutation against `<baseUrl>/api/graphql`. Returns `data`. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** URL-encode a group/project id or full path for use in a request path. */
export function encodeId(idOrPath: string | number): string {
  return encodeURIComponent(String(idOrPath));
}

/** Returns a thin authed REST client for a GitLab instance. */
export function createClient(opts: GitLabClientOptions): GitLabClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const baseClean = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const root = `${baseClean}${API_PATH}`;
  const graphqlUrl = `${baseClean}/api/graphql`;

  async function raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ res: Response; text: string }> {
    const url = /^https?:\/\//.test(path) ? path : `${root}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          "PRIVATE-TOKEN": opts.token,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        redirect: "manual",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new GitLabApiError(
        `network error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      let detail = "";
      try {
        const t = await res.text();
        if (t) detail = `: ${t.slice(0, 500)}`;
      } catch {
        // best-effort
      }
      throw new GitLabApiError(`${method} ${path} returned ${res.status}${detail}`, res.status);
    }

    const text = res.status === 204 ? "" : await res.text();
    return { res, text };
  }

  return {
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const { text } = await raw(method, path, body);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GitLabApiError(`could not parse response from ${method} ${path} as JSON`);
      }
    },

    async paginate<T = unknown>(path: string, perPage = 100): Promise<T[]> {
      const sep = path.includes("?") ? "&" : "?";
      const out: T[] = [];
      let page = 1;
      for (;;) {
        let r: { res: Response; text: string };
        try {
          r = await raw("GET", `${path}${sep}per_page=${perPage}&page=${page}`);
        } catch (err) {
          if (err instanceof GitLabApiError && err.statusCode === 404) return out;
          throw err;
        }
        if (r.text) {
          const chunk = JSON.parse(r.text);
          if (Array.isArray(chunk)) out.push(...(chunk as T[]));
        }
        const next = r.res.headers.get("x-next-page");
        const n = next ? Number(next) : 0;
        if (!n || n <= page) break;
        page = n;
      }
      return out;
    },

    async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      let res: Response;
      try {
        res = await doFetch(graphqlUrl, {
          method: "POST",
          headers: {
            "PRIVATE-TOKEN": opts.token,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          redirect: "manual",
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        throw new GitLabApiError(`network error on GraphQL: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        throw new GitLabApiError(`GraphQL returned ${res.status}`, res.status);
      }
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> }) : {};
      if (parsed.errors && parsed.errors.length > 0) {
        throw new GitLabApiError(`GraphQL error: ${parsed.errors.map((e) => e.message ?? "?").join("; ")}`);
      }
      return (parsed.data ?? {}) as T;
    },
  };
}
