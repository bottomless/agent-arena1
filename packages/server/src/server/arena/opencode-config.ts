import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ArenaOpenCodeLaunch {
  configPath: string;
  env: Record<string, string>;
}

export async function writeArenaOpenCodeConfig(input: {
  paseoHome: string;
  key: string;
  modelToken: string;
  modelLabel: string;
  proxyBaseUrl: string;
  inferenceToken: string;
}): Promise<ArenaOpenCodeLaunch> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.key)) throw new Error("Invalid Arena config key");
  const configPath = join(input.paseoHome, "arena", "opencode", `${input.key}.json`);
  const modelDefinition = {
    name: input.modelLabel,
    reasoning: true,
    tool_call: true,
    limit: { context: 128_000, output: 32_000 },
  };
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `arena/${input.modelToken}`,
    small_model: `arena/${input.modelToken}`,
    provider: {
      arena: {
        npm: "@ai-sdk/openai-compatible",
        name: "Arena",
        options: {
          baseURL: input.proxyBaseUrl,
          apiKey: "{env:ARENA_INFERENCE_TOKEN}",
        },
        models: {
          [input.modelToken]: modelDefinition,
          single: {
            ...modelDefinition,
            name: "Single agent",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
              max: { reasoningEffort: "max" },
            },
          },
        },
      },
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  return {
    configPath,
    env: {
      OPENCODE_CONFIG: configPath,
      ARENA_INFERENCE_TOKEN: input.inferenceToken,
    },
  };
}
