import { describe, expect, it, vi } from "vitest";

import type { ArenaBattle } from "@getpaseo/protocol/arena";
import { findArenaBattleForAgent, findArenaBattleForWorkspace } from "./store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

function battle(input: {
  id: string;
  sourceAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  open: boolean;
}): ArenaBattle {
  return {
    id: input.id,
    prompt: "Implement the change",
    sourceAgentId: input.sourceAgentId,
    sourceWorkspaceId: "workspace",
    status: input.open ? "running" : "decided",
    sides: {
      A: { side: "A", agentId: `${input.id}-a`, workspaceId: "workspace-a", status: "running" },
      B: { side: "B", agentId: `${input.id}-b`, workspaceId: "workspace-b", status: "running" },
    },
    decision: input.open ? null : "A",
    winningSide: input.open ? null : "A",
    decidedEarly: false,
    reveal: input.open ? null : { A: "model-a", B: "model-b" },
    diff: null,
    comparison: { status: "pending" },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    decidedAt: input.open ? null : input.updatedAt,
  };
}

describe("findArenaBattleForAgent", () => {
  it("prefers the open battle when an older summary receives a later update", () => {
    const olderDecided = battle({
      id: "older",
      sourceAgentId: "agent",
      createdAt: "2026-08-12T10:00:00.000Z",
      updatedAt: "2026-08-12T10:20:00.000Z",
      open: false,
    });
    const current = battle({
      id: "current",
      sourceAgentId: "agent",
      createdAt: "2026-08-12T10:10:00.000Z",
      updatedAt: "2026-08-12T10:10:00.000Z",
      open: true,
    });

    expect(
      findArenaBattleForAgent(
        { "server:older": olderDecided, "server:current": current },
        "server",
        "agent",
      )?.id,
    ).toBe("current");
  });
});

describe("findArenaBattleForWorkspace", () => {
  it("keeps an open first-prompt battle ahead of older failed attempts", () => {
    const failed = battle({
      id: "failed",
      sourceAgentId: null,
      createdAt: "2026-08-12T10:00:00.000Z",
      updatedAt: "2026-08-12T10:00:01.000Z",
      open: false,
    });
    failed.status = "error";
    failed.sourceWorkspaceId = "workspace";
    const current = battle({
      id: "current",
      sourceAgentId: null,
      createdAt: "2026-08-12T10:10:00.000Z",
      updatedAt: "2026-08-12T10:10:00.000Z",
      open: true,
    });
    current.sourceWorkspaceId = "workspace";

    expect(
      findArenaBattleForWorkspace(
        { "server:failed": failed, "server:current": current },
        "server",
        "workspace",
      )?.id,
    ).toBe("current");
  });
});
