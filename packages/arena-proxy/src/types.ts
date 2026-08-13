export type ArenaSide = "A" | "B";
export type ArenaVote = ArenaSide | "tie" | "stopped";

export interface ArenaModelCandidate {
  key: "glm" | "qwen" | "deepseek";
  modelId: string;
}

export interface StoredProxyBattle {
  id: string;
  userId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  assignments: Record<
    ArenaSide,
    {
      token: string;
      modelKey: ArenaModelCandidate["key"];
      modelId: string;
      completedAt: string | null;
    }
  >;
  vote: ArenaVote | null;
  winningSide: ArenaSide | null;
  decidedEarly: boolean;
  decidedAt: string | null;
  comparison:
    | { status: "pending" }
    | { status: "generating" }
    | { status: "completed"; summary: string }
    | { status: "error"; error: string }
    | { status: "unavailable"; reason: string };
}

export interface PublicProxyBattle {
  id: string;
  createdAt: string;
  updatedAt: string;
  vote: ArenaVote | null;
  winningSide: ArenaSide | null;
  decidedEarly: boolean;
  decidedAt: string | null;
  reveal: { A: string; B: string } | null;
  comparison: StoredProxyBattle["comparison"];
}

export interface CreatedProxyBattle extends PublicProxyBattle {
  sideTokens: Record<ArenaSide, string>;
}
