import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  ArenaBattleService,
  hasSubstantiveAssistantReply,
  renderBattleComparisonInput,
  resolveBattleBaseRef,
  selectBattleTranscriptRows,
} from "./battle-service.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { ArenaProxyBattleState, ArenaProxyClient } from "./proxy-client.js";
import type { StoredArenaBattle } from "./store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storedBattle(statusA: "completed", statusB: "running" | "completed" | "error") {
  const timestamp = "2026-08-12T12:00:00.000Z";
  return {
    battle: {
      id: "battle-test",
      prompt: "Implement it",
      sourceAgentId: null,
      sourceWorkspaceId: "source-workspace",
      status: statusB === "running" ? "running" : "awaiting_vote",
      sides: {
        A: {
          side: "A",
          agentId: null,
          workspaceId: "workspace-a",
          status: statusA,
          finishedAt: timestamp,
        },
        B: {
          side: "B",
          agentId: null,
          workspaceId: "workspace-b",
          status: statusB,
          ...(statusB === "running" ? {} : { finishedAt: timestamp }),
        },
      },
      decision: null,
      winningSide: null,
      decidedEarly: false,
      reveal: null,
      diff: null,
      comparison: { status: "pending" },
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
    },
    secrets: {
      A: {
        modelToken: "opaque-a",
        configPath: null,
        worktreePath: null,
        agentCwd: null,
      },
      B: {
        modelToken: "opaque-b",
        configPath: null,
        worktreePath: null,
        agentCwd: null,
      },
    },
  } satisfies StoredArenaBattle;
}

async function makeService(stored: StoredArenaBattle, proxyState: ArenaProxyBattleState) {
  const paseoHome = await mkdtemp(join(tmpdir(), "paseo-arena-service-"));
  roots.push(paseoHome);
  const recordPath = join(paseoHome, "arena", "battles", `${stored.battle.id}.json`);
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify(stored));
  const proxy = {
    markComplete: vi.fn().mockResolvedValue(proxyState),
    vote: vi.fn().mockResolvedValue(proxyState),
  };
  const emitUpdate = vi.fn();
  const setWorkspaceInternal = vi.fn().mockResolvedValue(undefined);
  const service = new ArenaBattleService({
    paseoHome,
    serverId: "server-test",
    agentManager: {} as AgentManager,
    agentStorage: {} as AgentStorage,
    logger: pino({ level: "silent" }),
    getWorkspace: vi.fn(),
    createWorktree: vi.fn(),
    archiveWorkspace: vi.fn().mockResolvedValue(undefined),
    setWorkspaceInternal,
    emitUpdate,
    proxy: proxy as unknown as ArenaProxyClient,
  });
  return { service, proxy, emitUpdate, setWorkspaceInternal };
}

describe("ArenaBattleService voting", () => {
  it("promotes a finished side immediately and cancels the unfinished side", async () => {
    const proxyState: ArenaProxyBattleState = {
      id: "battle-test",
      vote: "A",
      winningSide: "A",
      decidedEarly: true,
      decidedAt: "2026-08-12T12:01:00.000Z",
      reveal: { A: "model-a", B: "model-b" },
      comparison: {
        status: "unavailable",
        reason: "Comparison unavailable—battle decided early",
      },
    };
    const { service, proxy, emitUpdate, setWorkspaceInternal } = await makeService(
      storedBattle("completed", "running"),
      proxyState,
    );

    const result = await service.vote("battle-test", "A");

    expect(proxy.markComplete).toHaveBeenCalledWith("battle-test", "A");
    expect(proxy.vote).toHaveBeenCalledWith("battle-test", "A");
    expect(setWorkspaceInternal).toHaveBeenCalledWith("workspace-a", false);
    expect(result).toMatchObject({
      status: "decided",
      decision: "A",
      winningSide: "A",
      decidedEarly: true,
      sides: { B: { status: "cancelled" } },
    });
    expect(emitUpdate).toHaveBeenLastCalledWith(result);
  });

  it("requires both sides to finish successfully before recording a tie", async () => {
    const proxyState: ArenaProxyBattleState = {
      id: "battle-test",
      vote: "tie",
      winningSide: "A",
      decidedEarly: false,
      decidedAt: "2026-08-12T12:01:00.000Z",
      reveal: { A: "model-a", B: "model-b" },
      comparison: { status: "pending" },
    };
    const { service, proxy } = await makeService(storedBattle("completed", "error"), proxyState);

    await expect(service.vote("battle-test", "tie")).rejects.toThrow(
      "Both sides must finish successfully",
    );
    expect(proxy.vote).not.toHaveBeenCalled();
  });
});

describe("resolveBattleBaseRef", () => {
  it("resolves the exact source commit instead of passing HEAD to worktree creation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "paseo-arena-base-ref-"));
    roots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "arena@example.test"], {
      cwd: repo,
    });
    execFileSync("git", ["config", "user.name", "Arena Test"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "arena\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repo });
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    await expect(resolveBattleBaseRef(repo)).resolves.toBe(expected);
    expect(expected).not.toBe("HEAD");
  });
});

describe("renderBattleComparisonInput", () => {
  it("explains when both agents made the same edits", () => {
    const rendered = renderBattleComparisonInput(
      {
        files: [],
        totalFiles: 10,
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        generatedAt: "2026-08-12T12:00:00.000Z",
      },
      true,
    );
    expect(rendered).toContain("two final worktrees are identical");
    expect(rendered).toContain("file edits were detected");
    expect(rendered).not.toContain("Changed files shown: 0/0");
  });
});

describe("hasSubstantiveAssistantReply", () => {
  const row = (seq: number, item: AgentTimelineRow["item"]): AgentTimelineRow => ({
    seq,
    timestamp: `2026-08-12T12:00:0${seq}.000Z`,
    item,
  });

  it("accepts a real assistant reply after the captured timeline boundary", () => {
    expect(
      hasSubstantiveAssistantReply(
        [
          row(1, { type: "user_message", text: "earlier" }),
          row(2, { type: "assistant_message", text: "old answer" }),
          row(3, { type: "user_message", text: "Build this" }),
          row(4, {
            type: "assistant_message",
            text: "Implemented and tested.",
          }),
        ],
        2,
      ),
    ).toBe(true);
  });

  it("rejects inherited replies and synthetic provider errors", () => {
    const rows = [
      row(1, { type: "assistant_message", text: "old answer" }),
      row(2, { type: "user_message", text: "Build this" }),
      row(3, {
        type: "assistant_message",
        text: "[System Error] Provider failed",
      }),
    ];
    expect(hasSubstantiveAssistantReply(rows, 2)).toBe(false);
  });

  it("retains only the battle turn after the fork boundary", () => {
    const rows = [
      row(1, { type: "assistant_message", text: "inherited" }),
      row(2, { type: "user_message", text: "Build this" }),
      row(3, { type: "reasoning", text: "Working" }),
      row(4, { type: "assistant_message", text: "Done" }),
    ];
    expect(selectBattleTranscriptRows(rows, 1)).toEqual(rows.slice(1));
  });
});
