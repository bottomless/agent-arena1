import type { ArenaBattleComparison, ArenaBattleReveal } from "@getpaseo/protocol/arena";

export interface ArenaProxyCreatedBattle {
  id: string;
  sideTokens: { A: string; B: string };
}

export interface ArenaProxyBattleState {
  id: string;
  vote: "A" | "B" | "tie" | "stopped" | null;
  winningSide: "A" | "B" | null;
  decidedEarly: boolean;
  decidedAt: string | null;
  reveal: ArenaBattleReveal | null;
  comparison: ArenaBattleComparison;
}

export class ArenaProxyClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): ArenaProxyClient {
    const baseUrl = env.ARENA_PROXY_URL?.trim();
    const apiToken = env.ARENA_API_TOKEN?.trim();
    if (!baseUrl || !apiToken) {
      throw new Error("Arena requires ARENA_PROXY_URL and ARENA_API_TOKEN on the Paseo daemon");
    }
    return new ArenaProxyClient(baseUrl, apiToken);
  }

  get openAiBaseUrl(): string {
    return `${this.baseUrl}/v1`;
  }

  get token(): string {
    return this.apiToken;
  }

  createBattle(input: { userId: string; prompt: string }): Promise<ArenaProxyCreatedBattle> {
    return this.request("/api/battles", { method: "POST", body: input });
  }

  getBattle(id: string): Promise<ArenaProxyBattleState> {
    return this.request(`/api/battles/${encodeURIComponent(id)}`, { method: "GET" });
  }

  markComplete(id: string, side: "A" | "B"): Promise<ArenaProxyBattleState> {
    return this.request(`/api/battles/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: { side },
    });
  }

  vote(id: string, vote: "A" | "B" | "tie"): Promise<ArenaProxyBattleState> {
    return this.request(`/api/battles/${encodeURIComponent(id)}/vote`, {
      method: "POST",
      body: { vote },
    });
  }

  stop(id: string): Promise<ArenaProxyBattleState> {
    return this.request(`/api/battles/${encodeURIComponent(id)}/stop`, { method: "POST" });
  }

  startComparison(
    id: string,
    prompt: string,
    diff: string,
    changedFiles: number,
    hasEdits: boolean,
  ): Promise<ArenaProxyBattleState> {
    return this.request(`/api/battles/${encodeURIComponent(id)}/comparison`, {
      method: "POST",
      body: { prompt, diff, changedFiles, hasEdits },
    });
  }

  private async request<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown },
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = (await response.json().catch(() => null)) as
      | (T & { error?: unknown })
      | { error?: unknown }
      | null;
    if (!response.ok) {
      const message =
        parsed && typeof parsed.error === "string"
          ? parsed.error
          : `Arena proxy request failed (${response.status})`;
      throw new Error(message);
    }
    return parsed as T;
  }
}
