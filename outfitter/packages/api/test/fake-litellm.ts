// #394: a fake LiteLLM management API (the routes central/litellm-keys.ts calls), as a `fetch`, so
// key, user, team and spend tests never reach a real router. Records every call; `failNext` makes
// the next call to a path answer an error.

export interface FakeLitellmCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization: string | null;
}

export interface FakeKey {
  key: string;
  token: string;
  key_alias: string;
  user_id: string;
  metadata: Record<string, unknown>;
  request: Record<string, unknown>;
}

export class FakeLitellm {
  readonly calls: FakeLitellmCall[] = [];
  readonly users = new Map<string, { user_id: string; user_email: string }>();
  readonly keys = new Map<string, FakeKey>();
  readonly teams: Array<{ team_id: string; team_alias: string }> = [];
  /** What GET /spend/logs answers (both the per-user and the operator call). */
  spendLogs: unknown[] = [];
  /** /user/info for an unknown user: "404" (current LiteLLM) or "null" (older: 200, user_info null). */
  unknownUser: "404" | "null" = "404";
  /** Off: every call throws, as when the router is down. */
  down = false;
  private readonly failures = new Map<string, Array<{ status: number; body: unknown }>>();
  private seq = 0;

  failNext(path: string, status: number, body: unknown = { error: { message: "boom" } }): void {
    const list = this.failures.get(path) ?? [];
    list.push({ status, body });
    this.failures.set(path, list);
  }

  callsTo(path: string): FakeLitellmCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FakeLitellmCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get("authorization"),
    };
    this.calls.push(call);
    if (this.down) throw new TypeError("fetch failed");
    const failure = this.failures.get(call.path)?.shift();
    if (failure) return json(failure.status, failure.body);
    return this.answer(call);
  };

  private answer(call: FakeLitellmCall): Response {
    switch (`${call.method} ${call.path}`) {
      case "GET /user/info": {
        const user = this.users.get(call.query.user_id);
        if (!user) return this.unknownUser === "404" ? json(404, { detail: { error: "User not found" } }) : json(200, { user_id: call.query.user_id, user_info: null, keys: [] });
        const keys = [...this.keys.values()].filter((k) => k.user_id === user.user_id).map((k) => ({ token: k.token, key_alias: k.key_alias, metadata: k.metadata }));
        return json(200, { user_id: user.user_id, user_info: { ...user, spend: 0 }, keys });
      }
      case "POST /user/new": {
        if (this.users.has(call.body.user_id)) return json(400, { error: { message: "User already exists" } });
        this.users.set(call.body.user_id, { user_id: call.body.user_id, user_email: call.body.user_email });
        return json(200, { user_id: call.body.user_id });
      }
      case "GET /user/list":
        return json(200, { users: [...this.users.values()], total: this.users.size, page: 1 });
      case "POST /key/generate": {
        const n = ++this.seq;
        const k: FakeKey = {
          key: `sk-fake-${n}-secretvalue`,
          token: `hashed-token-${n}`,
          key_alias: call.body.key_alias,
          user_id: call.body.user_id,
          metadata: call.body.metadata ?? {},
          request: call.body,
        };
        this.keys.set(k.token, k);
        return json(200, { key: k.key, token: k.token, key_alias: k.key_alias, expires: "2027-01-02T03:04:05.000Z", user_id: k.user_id });
      }
      case "POST /key/delete": {
        const tokens: string[] = call.body.keys ?? [];
        const aliases: string[] = call.body.key_aliases ?? [];
        const matches = [...this.keys.values()].filter((k) => tokens.includes(k.token) || aliases.includes(k.key_alias));
        if (!matches.length) return json(404, { detail: { error: "Key not found" } });
        for (const k of matches) this.keys.delete(k.token);
        return json(200, { deleted_keys: matches.map((k) => k.token) });
      }
      case "GET /team/list":
        return json(200, this.teams);
      case "POST /team/new": {
        const team = { team_id: `team-${this.teams.length + 1}`, team_alias: call.body.team_alias };
        this.teams.push(team);
        return json(200, team);
      }
      case "GET /spend/logs":
        return json(200, this.spendLogs);
      default:
        return json(404, { detail: "Not Found" });
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
