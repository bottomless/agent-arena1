import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArenaProxyService, deriveSingleInferenceToken } from "./service.js";

const temporaryDirectories: string[] = [];

async function makeService() {
  const root = await mkdtemp(join(tmpdir(), "paseo-arena-proxy-"));
  temporaryDirectories.push(root);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          { id: "deepseek/deepseek-v4-pro-0801", created: 1 },
          { id: "deepseek/deepseek-v4-pro", created: 2 },
        ],
      }),
      { status: 200 },
    ),
  );
  const picks = [0, 0];
  const service = new ArenaProxyService({
    apiToken: "test-token",
    openRouterApiKey: "openrouter-test",
    dataDir: root,
    fallbackDeepSeekModel: "deepseek/deepseek-v4-pro-fallback",
    fetchImpl,
    randomIndex: () => picks.shift() ?? 0,
  });
  return { service, fetchImpl };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ArenaProxyService", () => {
  it("separates battle-control and model-inference credentials", async () => {
    const { service, fetchImpl } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models/user",
      expect.objectContaining({
        headers: { Authorization: "Bearer openrouter-test" },
      }),
    );
    expect(service.isAuthorized("Bearer test-token")).toBe(true);
    expect(service.isAuthorized(`Bearer ${created.sideTokens.A}`)).toBe(false);
    expect(
      service.isInferenceAuthorized(`Bearer ${created.sideTokens.A}`, created.sideTokens.A),
    ).toBe(true);
    expect(service.isInferenceAuthorized("Bearer test-token", created.sideTokens.A)).toBe(false);
    expect(
      service.isInferenceAuthorized(`Bearer ${deriveSingleInferenceToken("test-token")}`, "single"),
    ).toBe(true);
  });

  it("keeps assignments blinded until a valid vote", async () => {
    const { service } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    expect(created.reveal).toBeNull();
    expect(created.sideTokens.A).not.toBe(created.sideTokens.B);

    await expect(service.vote(created.id, "A")).rejects.toThrow("not finished");
    await service.markComplete(created.id, "A");
    const decided = await service.vote(created.id, "A");
    expect(decided.reveal).toEqual({
      A: "z-ai/glm-5.2",
      B: "qwen/qwen3.8-max",
    });
    expect(decided.decidedEarly).toBe(true);
    expect(decided.comparison.status).toBe("unavailable");
  });

  it("records a tie while operationally selecting A", async () => {
    const { service } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await service.markComplete(created.id, "A");
    await service.markComplete(created.id, "B");
    const decided = await service.vote(created.id, "tie");
    expect(decided.vote).toBe("tie");
    expect(decided.winningSide).toBe("A");
    expect(decided.decidedEarly).toBe(false);
  });

  it("serializes simultaneous side completions without losing either result", async () => {
    const { service } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await Promise.all([
      service.markComplete(created.id, "A"),
      service.markComplete(created.id, "B"),
    ]);
    await expect(service.vote(created.id, "tie")).resolves.toMatchObject({
      vote: "tie",
      winningSide: "A",
      decidedEarly: false,
    });
  });

  it("keeps stopped battles blinded and revokes both tokens", async () => {
    const { service } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    const stopped = await service.stop(created.id);
    expect(stopped.reveal).toBeNull();
    expect(await service.resolveModelToken(created.sideTokens.A)).toBeNull();
    expect(await service.resolveModelToken(created.sideTokens.B)).toBeNull();
  });

  it("does not let a late comparison overwrite a stopped decision", async () => {
    const { service, fetchImpl } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await service.markComplete(created.id, "A");
    await service.markComplete(created.id, "B");
    let finishSummary: (response: Response) => void = () => undefined;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSummary = resolve;
        }),
    );

    await service.startComparison(created.id, "Implement it", "diff", 1, true);
    await service.stop(created.id);
    finishSummary(
      new Response(JSON.stringify({ choices: [{ message: { content: "Late summary" } }] }), {
        status: 200,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await service.getBattle(created.id)).comparison).toEqual({
      status: "unavailable",
      reason: "Battle stopped",
    });
  });

  it("skips the comparison model when neither worktree has file edits", async () => {
    const { service, fetchImpl } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await service.markComplete(created.id, "A");
    await service.markComplete(created.id, "B");
    fetchImpl.mockClear();

    const result = await service.startComparison(
      created.id,
      "Implement it",
      "No differences",
      0,
      false,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.comparison).toEqual({
      status: "unavailable",
      reason: "AI comparison skipped—neither agent edited files",
    });
  });

  it("compares identical A and B edits even when their direct diff is empty", async () => {
    const { service, fetchImpl } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await service.markComplete(created.id, "A");
    await service.markComplete(created.id, "B");
    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Same implementation" } }],
        }),
        {
          status: 200,
        },
      ),
    );

    const result = await service.startComparison(
      created.id,
      "Implement it",
      "Changed files shown: 0/0",
      0,
      true,
    );

    expect(result.comparison).toEqual({ status: "generating" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const [, request] = fetchImpl.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String(request?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody.messages[0]?.content).toBe(
      'The user is evaluating two candidate changes, and the diff is between candidate A and candidate B. Give a concise summary of what is different between them. For example: "Version A does X, while Version B does Y."',
    );
    await vi.waitFor(async () => {
      await expect(service.getBattle(created.id)).resolves.toMatchObject({
        comparison: { status: "completed", summary: "Same implementation" },
      });
    });
  });

  it("maps opaque model tokens when forwarding requests", async () => {
    const { service, fetchImpl } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    fetchImpl.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await service.forwardChatCompletion({
      model: created.sideTokens.A,
      messages: [],
      user: "raw-user-id",
      metadata: { session: "private-session" },
    });
    const [, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "z-ai/glm-5.2",
      messages: [],
    });
  });

  it("revokes both terminal side tokens after a decision", async () => {
    const { service } = await makeService();
    const created = await service.createBattle("user-hash", "Implement it");
    await service.markComplete(created.id, "A");
    await service.vote(created.id, "A");
    expect(await service.resolveModelToken(created.sideTokens.A)).toBeNull();
    expect(await service.resolveModelToken(created.sideTokens.B)).toBeNull();
  });
});
