import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeArenaOpenCodeConfig } from "./opencode-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("writeArenaOpenCodeConfig", () => {
  it("creates a private OpenCode provider config with the Arena thinking variants", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-arena-opencode-"));
    roots.push(paseoHome);

    const launch = await writeArenaOpenCodeConfig({
      paseoHome,
      key: "single-test",
      modelToken: "single",
      modelLabel: "Single agent",
      proxyBaseUrl: "https://arena.example/v1",
      inferenceToken: "inference-secret",
    });
    const config = JSON.parse(await readFile(launch.configPath, "utf8")) as {
      model: string;
      provider: {
        arena: {
          options: { baseURL: string; apiKey: string };
          models: {
            single: { variants: Record<string, { reasoningEffort: string }> };
          };
        };
      };
    };

    expect(launch.env).toEqual({
      OPENCODE_CONFIG: launch.configPath,
      ARENA_INFERENCE_TOKEN: "inference-secret",
    });
    expect(config.model).toBe("arena/single");
    expect(config.provider.arena.options).toEqual({
      baseURL: "https://arena.example/v1",
      apiKey: "{env:ARENA_INFERENCE_TOKEN}",
    });
    expect(config.provider.arena.models.single.variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
      max: { reasoningEffort: "max" },
    });
    expect((await stat(launch.configPath)).mode & 0o777).toBe(0o600);
  });
});
