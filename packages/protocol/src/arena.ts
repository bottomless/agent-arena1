import { z } from "zod";

export const ArenaBattleSideIdSchema = z.enum(["A", "B"]);
export type ArenaBattleSideId = z.infer<typeof ArenaBattleSideIdSchema>;

export const ArenaBattleSideStatusSchema = z.enum([
  "preparing",
  "running",
  "completed",
  "cancelled",
  "error",
]);
export type ArenaBattleSideStatus = z.infer<typeof ArenaBattleSideStatusSchema>;

export const ArenaBattleDecisionSchema = z.enum(["A", "B", "tie", "stopped"]);
export type ArenaBattleDecision = z.infer<typeof ArenaBattleDecisionSchema>;

export const ArenaBattleStatusSchema = z.enum([
  "preparing",
  "running",
  "awaiting_vote",
  "decided",
  "stopped",
  "error",
]);
export type ArenaBattleStatus = z.infer<typeof ArenaBattleStatusSchema>;

export const ArenaDiffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(z.string()),
  truncated: z.boolean().optional(),
});

export const ArenaDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added_a", "added_b", "modified", "type_changed", "binary"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  bytesA: z.number().int().nonnegative().optional(),
  bytesB: z.number().int().nonnegative().optional(),
  hunks: z.array(ArenaDiffHunkSchema),
  truncated: z.boolean().optional(),
});
export type ArenaDiffFile = z.infer<typeof ArenaDiffFileSchema>;

export const ArenaBattleDiffSchema = z.object({
  files: z.array(ArenaDiffFileSchema),
  totalFiles: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
  generatedAt: z.string(),
});
export type ArenaBattleDiff = z.infer<typeof ArenaBattleDiffSchema>;

export const ArenaBattleComparisonSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("generating") }),
  z.object({ status: z.literal("completed"), summary: z.string() }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);
export type ArenaBattleComparison = z.infer<typeof ArenaBattleComparisonSchema>;

export const ArenaBattleTranscriptRowSchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  // The canonical agent endpoint validates the complete timeline-item union.
  // Arena retains that payload here so archived sides can still be replayed.
  item: z.object({ type: z.string() }).passthrough(),
});
export type ArenaBattleTranscriptRow = z.infer<typeof ArenaBattleTranscriptRowSchema>;

export const ArenaBattleSideSchema = z.object({
  side: ArenaBattleSideIdSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  status: ArenaBattleSideStatusSchema,
  finishedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  transcript: z.array(ArenaBattleTranscriptRowSchema).optional(),
});
export type ArenaBattleSide = z.infer<typeof ArenaBattleSideSchema>;

export const ArenaBattleRevealSchema = z.object({
  A: z.string(),
  B: z.string(),
});
export type ArenaBattleReveal = z.infer<typeof ArenaBattleRevealSchema>;

export const ArenaBattleSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  sourceAgentId: z.string().nullable(),
  sourceWorkspaceId: z.string(),
  status: ArenaBattleStatusSchema,
  sides: z.object({
    A: ArenaBattleSideSchema,
    B: ArenaBattleSideSchema,
  }),
  decision: ArenaBattleDecisionSchema.nullable(),
  winningSide: ArenaBattleSideIdSchema.nullable(),
  decidedEarly: z.boolean(),
  reveal: ArenaBattleRevealSchema.nullable(),
  diff: ArenaBattleDiffSchema.nullable(),
  comparison: ArenaBattleComparisonSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ArenaBattle = z.infer<typeof ArenaBattleSchema>;

export const ArenaBattleStartRequestSchema = z.object({
  type: z.literal("arena.battle.start.request"),
  requestId: z.string(),
  sourceAgentId: z.string().optional(),
  workspaceId: z.string(),
  prompt: z.string().min(1),
});

export const ArenaBattleGetRequestSchema = z.object({
  type: z.literal("arena.battle.get.request"),
  requestId: z.string(),
  battleId: z.string(),
});

export const ArenaBattleListRequestSchema = z.object({
  type: z.literal("arena.battle.list.request"),
  requestId: z.string(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
});

export const ArenaBattleVoteRequestSchema = z.object({
  type: z.literal("arena.battle.vote.request"),
  requestId: z.string(),
  battleId: z.string(),
  decision: z.enum(["A", "B", "tie"]),
});

export const ArenaBattleStopRequestSchema = z.object({
  type: z.literal("arena.battle.stop.request"),
  requestId: z.string(),
  battleId: z.string(),
});

export const ArenaThinkingLevelSchema = z.enum(["low", "high", "max"]);
export type ArenaThinkingLevel = z.infer<typeof ArenaThinkingLevelSchema>;

export const ArenaSingleTurnRequestSchema = z.object({
  type: z.literal("arena.single.turn.request"),
  requestId: z.string(),
  agentId: z.string().optional(),
  workspaceId: z.string(),
  prompt: z.string().min(1),
  thinkingLevel: ArenaThinkingLevelSchema.optional(),
});

export const ArenaBattleStartResponseSchema = z.object({
  type: z.literal("arena.battle.start.response"),
  payload: z.object({ requestId: z.string(), battle: ArenaBattleSchema }),
});

export const ArenaBattleGetResponseSchema = z.object({
  type: z.literal("arena.battle.get.response"),
  payload: z.object({ requestId: z.string(), battle: ArenaBattleSchema }),
});

export const ArenaBattleListResponseSchema = z.object({
  type: z.literal("arena.battle.list.response"),
  payload: z.object({ requestId: z.string(), battles: z.array(ArenaBattleSchema) }),
});

export const ArenaBattleVoteResponseSchema = z.object({
  type: z.literal("arena.battle.vote.response"),
  payload: z.object({ requestId: z.string(), battle: ArenaBattleSchema }),
});

export const ArenaBattleStopResponseSchema = z.object({
  type: z.literal("arena.battle.stop.response"),
  payload: z.object({ requestId: z.string(), battle: ArenaBattleSchema }),
});

export const ArenaBattleUpdateSchema = z.object({
  type: z.literal("arena.battle.update"),
  payload: z.object({ battle: ArenaBattleSchema }),
});

export const ArenaSingleTurnResponseSchema = z.object({
  type: z.literal("arena.single.turn.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    workspaceId: z.string(),
  }),
});

export type ArenaBattleStartRequest = z.infer<typeof ArenaBattleStartRequestSchema>;
export type ArenaBattleGetRequest = z.infer<typeof ArenaBattleGetRequestSchema>;
export type ArenaBattleListRequest = z.infer<typeof ArenaBattleListRequestSchema>;
export type ArenaBattleVoteRequest = z.infer<typeof ArenaBattleVoteRequestSchema>;
export type ArenaBattleStopRequest = z.infer<typeof ArenaBattleStopRequestSchema>;
export type ArenaSingleTurnRequest = z.infer<typeof ArenaSingleTurnRequestSchema>;
export type ArenaBattleStartResponse = z.infer<typeof ArenaBattleStartResponseSchema>;
export type ArenaBattleGetResponse = z.infer<typeof ArenaBattleGetResponseSchema>;
export type ArenaBattleListResponse = z.infer<typeof ArenaBattleListResponseSchema>;
export type ArenaBattleVoteResponse = z.infer<typeof ArenaBattleVoteResponseSchema>;
export type ArenaBattleStopResponse = z.infer<typeof ArenaBattleStopResponseSchema>;
export type ArenaBattleUpdate = z.infer<typeof ArenaBattleUpdateSchema>;
export type ArenaSingleTurnResponse = z.infer<typeof ArenaSingleTurnResponseSchema>;
