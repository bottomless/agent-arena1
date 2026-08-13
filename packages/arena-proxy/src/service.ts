import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  COMPARISON_MODEL,
  pickBlindedPair,
  resolveBattleModelPool,
  SINGLE_AGENT_MODEL,
} from "./model-pool.js";
import { ProxyBattleStore } from "./store.js";
import type {
  ArenaSide,
  ArenaVote,
  CreatedProxyBattle,
  PublicProxyBattle,
  StoredProxyBattle,
} from "./types.js";

export interface ArenaProxyConfig {
  apiToken: string;
  openRouterApiKey: string;
  dataDir: string;
  fallbackDeepSeekModel: string;
  fetchImpl?: typeof fetch;
  randomIndex?: (maxExclusive: number) => number;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerCredential(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function deriveSingleInferenceToken(apiToken: string): string {
  return `arena_single_${createHmac("sha256", apiToken)
    .update("paseo-arena-single-inference-v1")
    .digest("base64url")}`;
}

function publicBattle(record: StoredProxyBattle): PublicProxyBattle {
  const shouldReveal = record.vote !== null && record.vote !== "stopped";
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    vote: record.vote,
    winningSide: record.winningSide,
    decidedEarly: record.decidedEarly,
    decidedAt: record.decidedAt,
    reveal: shouldReveal
      ? { A: record.assignments.A.modelId, B: record.assignments.B.modelId }
      : null,
    comparison: record.comparison,
  };
}

function parseOpenRouterContent(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("Invalid OpenRouter response");
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) throw new Error("OpenRouter response has no choices");
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter comparison returned no text");
  }
  return content.trim();
}

export class ArenaProxyService {
  readonly store: ProxyBattleStore;
  private readonly fetchImpl: typeof fetch;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(readonly config: ArenaProxyConfig) {
    this.store = new ProxyBattleStore(config.dataDir);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isAuthorized(header: string | undefined): boolean {
    const credential = bearerCredential(header);
    return credential !== null && secureEquals(credential, this.config.apiToken);
  }

  isInferenceAuthorized(header: string | undefined, opaqueModel: string): boolean {
    const credential = bearerCredential(header);
    if (!credential) return false;
    const expected =
      opaqueModel === "single" ? deriveSingleInferenceToken(this.config.apiToken) : opaqueModel;
    return secureEquals(credential, expected);
  }

  async createBattle(userId: string, prompt: string): Promise<CreatedProxyBattle> {
    if (!userId.trim()) throw new Error("userId is required");
    if (!prompt.trim()) throw new Error("prompt is required");
    const pool = await resolveBattleModelPool({
      fetchImpl: this.fetchImpl,
      fallbackDeepSeekModel: this.config.fallbackDeepSeekModel,
      openRouterApiKey: this.config.openRouterApiKey,
    });
    const [modelA, modelB] = pickBlindedPair(pool, this.config.randomIndex);
    const now = new Date().toISOString();
    const record: StoredProxyBattle = {
      id: randomUUID(),
      userId: userId.trim(),
      prompt: prompt.trim(),
      createdAt: now,
      updatedAt: now,
      assignments: {
        A: {
          token: `arena_${randomBytes(24).toString("base64url")}`,
          modelKey: modelA.key,
          modelId: modelA.modelId,
          completedAt: null,
        },
        B: {
          token: `arena_${randomBytes(24).toString("base64url")}`,
          modelKey: modelB.key,
          modelId: modelB.modelId,
          completedAt: null,
        },
      },
      vote: null,
      winningSide: null,
      decidedEarly: false,
      decidedAt: null,
      comparison: { status: "pending" },
    };
    await this.store.put(record);
    return {
      ...publicBattle(record),
      sideTokens: {
        A: record.assignments.A.token,
        B: record.assignments.B.token,
      },
    };
  }

  async getBattle(id: string): Promise<PublicProxyBattle> {
    const record = await this.requireBattle(id);
    return publicBattle(record);
  }

  async markComplete(id: string, side: ArenaSide): Promise<PublicProxyBattle> {
    return this.withMutation(id, async () => {
      const record = await this.requireBattle(id);
      record.assignments[side].completedAt ??= new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      await this.store.put(record);
      return publicBattle(record);
    });
  }

  async vote(id: string, vote: Exclude<ArenaVote, "stopped">): Promise<PublicProxyBattle> {
    return this.withMutation(id, async () => {
      const record = await this.requireBattle(id);
      if (record.vote) throw new Error("Battle has already been decided");
      if (
        vote === "tie" &&
        (!record.assignments.A.completedAt || !record.assignments.B.completedAt)
      ) {
        throw new Error("Both sides must finish before recording a tie");
      }
      const winningSide: ArenaSide = vote === "tie" ? "A" : vote;
      if (!record.assignments[winningSide].completedAt) {
        throw new Error(`Side ${winningSide} is not finished`);
      }
      const now = new Date().toISOString();
      record.vote = vote;
      record.winningSide = winningSide;
      record.decidedEarly =
        record.assignments.A.completedAt === null || record.assignments.B.completedAt === null;
      record.decidedAt = now;
      record.updatedAt = now;
      if (record.decidedEarly) {
        record.comparison = {
          status: "unavailable",
          reason: "Comparison unavailable—battle decided early",
        };
      }
      await this.store.put(record);
      return publicBattle(record);
    });
  }

  async stop(id: string): Promise<PublicProxyBattle> {
    return this.withMutation(id, async () => {
      const record = await this.requireBattle(id);
      if (record.vote) throw new Error("Battle has already been decided");
      const now = new Date().toISOString();
      record.vote = "stopped";
      record.winningSide = null;
      record.decidedAt = now;
      record.updatedAt = now;
      record.comparison = { status: "unavailable", reason: "Battle stopped" };
      await this.store.put(record);
      return publicBattle(record);
    });
  }

  async resolveModelToken(token: string): Promise<string | null> {
    const battles = await this.store.list();
    for (const battle of battles) {
      for (const side of ["A", "B"] as const) {
        if (battle.assignments[side].token !== token) continue;
        // Side-scoped OpenCode sessions are terminal at vote time. Successor
        // turns receive fresh credentials, so neither side token remains live.
        if (battle.vote) return null;
        return battle.assignments[side].modelId;
      }
    }
    return null;
  }

  async resolveRequestedModel(token: string): Promise<string> {
    const model = token === "single" ? SINGLE_AGENT_MODEL : await this.resolveModelToken(token);
    if (!model) throw new Error("Unknown or expired Arena model token");
    return model;
  }

  async startComparison(
    id: string,
    prompt: string,
    diff: string,
    changedFiles: number,
    hasEdits: boolean,
  ): Promise<PublicProxyBattle> {
    const publicState = await this.withMutation(id, async () => {
      const record = await this.requireBattle(id);
      if (record.vote === "stopped")
        throw new Error("Comparison is unavailable for a stopped battle");
      if (record.decidedEarly) throw new Error("Comparison is unavailable for an early decision");
      if (!record.assignments.A.completedAt || !record.assignments.B.completedAt) {
        throw new Error("Both sides must finish before comparison");
      }
      if (record.prompt !== prompt.trim())
        throw new Error("Comparison prompt does not match battle");
      if (!Number.isInteger(changedFiles) || changedFiles < 0) {
        throw new Error("changedFiles must be a non-negative integer");
      }
      if (!hasEdits) {
        record.comparison = {
          status: "unavailable",
          reason: "AI comparison skipped—neither agent edited files",
        };
        record.updatedAt = new Date().toISOString();
        await this.store.put(record);
        return publicBattle(record);
      }
      record.comparison = { status: "generating" };
      record.updatedAt = new Date().toISOString();
      await this.store.put(record);
      return publicBattle(record);
    });
    if (!hasEdits) return publicState;
    void this.generateComparison(id, prompt, diff);
    return publicState;
  }

  async forwardChatCompletion(
    requestBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = requestBody.model;
    if (typeof token !== "string") throw new Error("model is required");
    const model = await this.resolveRequestedModel(token);
    const body: Record<string, unknown> = { ...requestBody, model };
    delete body.user;
    delete body.metadata;
    delete body.safety_identifier;
    delete body.prompt_cache_key;
    return this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://paseo.sh/arena",
        "X-Title": "Paseo Arena",
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async generateComparison(id: string, prompt: string, diff: string): Promise<void> {
    let comparison: StoredProxyBattle["comparison"];
    try {
      const response = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://paseo.sh/arena",
          "X-Title": "Paseo Arena comparison",
        },
        body: JSON.stringify({
          model: COMPARISON_MODEL,
          reasoning: { effort: "low" },
          messages: [
            {
              role: "system",
              content:
                'The user is evaluating two candidate changes, and the diff is between candidate A and candidate B. Give a concise summary of what is different between them. For example: "Version A does X, while Version B does Y."',
            },
            {
              role: "user",
              content: `Original request:\n${prompt}\n\nBounded A-vs-B diff:\n${diff}`,
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter comparison failed (${response.status})`);
      comparison = {
        status: "completed",
        summary: parseOpenRouterContent(await response.json()),
      };
    } catch (error) {
      comparison = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.withMutation(id, async () => {
      const record = await this.requireBattle(id);
      if (record.vote === "stopped") return;
      record.comparison = comparison;
      record.updatedAt = new Date().toISOString();
      await this.store.put(record);
    });
  }

  private async requireBattle(id: string): Promise<StoredProxyBattle> {
    const record = await this.store.get(id);
    if (!record) throw new Error("Battle not found");
    return record;
  }

  private async withMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(id) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (this.mutationTails.get(id) === tail) this.mutationTails.delete(id);
    }
  }
}
