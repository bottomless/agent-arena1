import { randomInt } from "node:crypto";

import type { ArenaModelCandidate } from "./types.js";

const GLM_MODEL = "z-ai/glm-5.2";
const QWEN_MODEL = "qwen/qwen3.8-max";
const V4_PRO_PATTERN = /^deepseek\/deepseek-v4-pro(?:-|$)/;

interface OpenRouterModel {
  id?: unknown;
  created?: unknown;
}

function newestV4Pro(models: OpenRouterModel[]): string | null {
  return (
    models
      .filter((model): model is OpenRouterModel & { id: string } => {
        return typeof model.id === "string" && V4_PRO_PATTERN.test(model.id);
      })
      .sort((left, right) => {
        const createdDelta = Number(right.created ?? 0) - Number(left.created ?? 0);
        return createdDelta || right.id.localeCompare(left.id);
      })[0]?.id ?? null
  );
}

export async function resolveBattleModelPool(options: {
  fetchImpl?: typeof fetch;
  fallbackDeepSeekModel: string;
  openRouterApiKey: string;
}): Promise<ArenaModelCandidate[]> {
  let deepseekModel = options.fallbackDeepSeekModel;
  try {
    const response = await (options.fetchImpl ?? fetch)(
      "https://openrouter.ai/api/v1/models/user",
      {
        headers: { Authorization: `Bearer ${options.openRouterApiKey}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.ok) {
      const body = (await response.json()) as { data?: OpenRouterModel[] };
      deepseekModel = newestV4Pro(body.data ?? []) ?? deepseekModel;
    }
  } catch {
    // Battle creation remains available during a transient catalog outage. The exact
    // fallback id is persisted, so the trial is still reproducible.
  }

  return [
    { key: "glm", modelId: GLM_MODEL },
    { key: "qwen", modelId: QWEN_MODEL },
    { key: "deepseek", modelId: deepseekModel },
  ];
}

export function pickBlindedPair(
  pool: readonly ArenaModelCandidate[],
  randomIndex: (maxExclusive: number) => number = randomInt,
): [ArenaModelCandidate, ArenaModelCandidate] {
  if (pool.length < 2) throw new Error("Arena model pool needs at least two models");
  const remaining = [...pool];
  const first = remaining.splice(randomIndex(remaining.length), 1)[0];
  const second = remaining.splice(randomIndex(remaining.length), 1)[0];
  if (!first || !second) throw new Error("Unable to select Arena models");
  return [first, second];
}

export const SINGLE_AGENT_MODEL = "~deepseek/deepseek-v4-flash-latest";
export const COMPARISON_MODEL = "openai/gpt-oss-120b:nitro";
