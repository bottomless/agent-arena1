import { createHash, createHmac, randomUUID } from "node:crypto";

import type {
  ArenaBattle,
  ArenaBattleDecision,
  ArenaBattleSideId,
  ArenaThinkingLevel,
} from "@getpaseo/protocol/arena";
import type { Logger } from "pino";

import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { buildAgentForkContextAttachment } from "../agent/activity-curator.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "../agent/lifecycle-command.js";
import type { CreatePaseoWorktreeInput } from "../paseo-worktree-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import {
  buildBoundedBattleDiff,
  fingerprintVisibleWorktree,
  hasBattleFileEdits,
  renderBattleDiffForComparison,
} from "./diff.js";
import { writeArenaOpenCodeConfig } from "./opencode-config.js";
import { ArenaProxyClient, type ArenaProxyBattleState } from "./proxy-client.js";
import { ArenaBattleStore, type StoredArenaBattle } from "./store.js";
import { copyWorkingTreeState } from "./working-tree.js";
import { runGitCommand } from "../../utils/run-git-command.js";

const TERMINAL_SIDE_STATUSES = new Set(["completed", "cancelled", "error"]);
const COMPARISON_POLL_INTERVAL_MS = 2_000;
const COMPARISON_POLL_ATTEMPTS = 150;
const LEGACY_NO_DIFF_REASON = "AI comparison skipped—no file differences";
const NO_EDITS_REASON = "AI comparison skipped—neither agent edited files";
const COMPARISON_DETECTION_VERSION = 2;
// Sessions are per WebSocket client, but battle storage is daemon-wide. Sharing
// this queue prevents two connected clients from clobbering the same JSON record.
const BATTLE_MUTATION_TAILS = new Map<string, Promise<void>>();

export interface ArenaBattleServiceDependencies {
  paseoHome: string;
  serverId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  getWorkspace(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  createWorktree(input: CreatePaseoWorktreeInput): Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  setWorkspaceInternal(workspaceId: string, internal: boolean): Promise<void>;
  emitUpdate(battle: ArenaBattle): void;
  proxy?: ArenaProxyClient;
}

function now(): string {
  return new Date().toISOString();
}

function pseudonymousUserId(serverId: string): string {
  return createHash("sha256").update(`paseo-arena:${serverId}`).digest("hex");
}

function singleInferenceToken(apiToken: string): string {
  return `arena_single_${createHmac("sha256", apiToken)
    .update("paseo-arena-single-inference-v1")
    .digest("base64url")}`;
}

function sideLabel(side: ArenaBattleSideId): string {
  return `Arena ${side}`;
}

const BATTLE_IDENTITY_INSTRUCTION =
  "This is a blinded coding-agent evaluation. Do not state, infer, or speculate about your model or provider identity.";

function isSideTerminal(status: ArenaBattle["sides"]["A"]["status"]): boolean {
  return TERMINAL_SIDE_STATUSES.has(status);
}

function cloneBattle(battle: ArenaBattle): ArenaBattle {
  return structuredClone(battle);
}

function isReusableSingleAgent(agent: ManagedAgent | null): boolean {
  // Battle-side credentials are scoped to an opaque side token. Reusing that
  // process for `arena/single` would fail authentication, so only single-mode
  // sessions can be reused in place.
  return agent?.labels.arenaManaged === "true" && agent.labels.arenaMode === "single";
}

function singleAgentLabels(source: ManagedAgent | null): Record<string, string> {
  const labels = { ...source?.labels };
  delete labels.arenaBattleId;
  delete labels.arenaSide;
  return { ...labels, arenaManaged: "true", arenaMode: "single" };
}

function titleFromPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}…`;
}

export function hasSubstantiveAssistantReply(
  rows: readonly AgentTimelineRow[],
  afterSeq: number,
): boolean {
  return rows.some((row) => {
    if (row.seq <= afterSeq) return false;
    if (row.item.type !== "assistant_message") return false;
    const text = row.item.text.trim();
    return text.length > 0 && !/^\[(?:system )?error\]/i.test(text);
  });
}

export function selectBattleTranscriptRows(
  rows: readonly AgentTimelineRow[],
  afterSeq: number,
): AgentTimelineRow[] {
  return rows.filter((row) => row.seq > afterSeq);
}

export function renderBattleComparisonInput(
  diff: NonNullable<ArenaBattle["diff"]>,
  hasEdits: boolean,
): string {
  const rendered = renderBattleDiffForComparison(diff);
  if (!hasEdits || diff.changedFiles > 0) return rendered;
  return [
    "A-versus-B result: the two final worktrees are identical, so there is no A-versus-B patch to show.",
    "Edit detection against the exact worktree state at battle launch: file edits were detected.",
    "Do not describe this as no files being edited. Both agents produced the same final implementation.",
  ].join("\n");
}

function applyProxyDecision(battle: ArenaBattle, state: ArenaProxyBattleState): void {
  battle.decision = state.vote;
  battle.winningSide = state.winningSide;
  battle.decidedEarly = state.decidedEarly;
  battle.decidedAt = state.decidedAt;
  battle.reveal = state.reveal;
  battle.comparison = state.comparison;
}

export async function resolveBattleBaseRef(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    timeout: 30_000,
  });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error("Unable to resolve the source workspace commit for this battle");
  }
  return commit;
}

export class ArenaBattleService {
  private readonly store: ArenaBattleStore;
  private readonly proxy: ArenaProxyClient;
  private readonly monitors = new Map<string, () => void>();

  constructor(private readonly dependencies: ArenaBattleServiceDependencies) {
    this.store = new ArenaBattleStore(dependencies.paseoHome);
    this.proxy = dependencies.proxy ?? ArenaProxyClient.fromEnvironment();
  }

  async startBattle(input: {
    sourceAgentId?: string;
    workspaceId: string;
    prompt: string;
  }): Promise<ArenaBattle> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    const source = input.sourceAgentId
      ? this.requireIdleSource(input.sourceAgentId, input.workspaceId)
      : null;
    if (source) await this.requireEligibleArenaSource(source);
    const proxyBattle = await this.proxy.createBattle({
      userId: pseudonymousUserId(this.dependencies.serverId),
      prompt: input.prompt,
    });
    const timestamp = now();
    const stored: StoredArenaBattle = {
      battle: {
        id: proxyBattle.id,
        prompt: input.prompt.trim(),
        sourceAgentId: source?.id ?? null,
        sourceWorkspaceId: workspace.workspaceId,
        status: "preparing",
        sides: {
          A: {
            side: "A",
            agentId: null,
            workspaceId: null,
            status: "preparing",
          },
          B: {
            side: "B",
            agentId: null,
            workspaceId: null,
            status: "preparing",
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
          modelToken: proxyBattle.sideTokens.A,
          configPath: null,
          worktreePath: null,
          agentCwd: null,
        },
        B: {
          modelToken: proxyBattle.sideTokens.B,
          configPath: null,
          worktreePath: null,
          agentCwd: null,
        },
      },
    };
    await this.persistAndEmit(stored);

    const createdWorkspaceIds: string[] = [];
    const createdAgentIds: string[] = [];
    try {
      const shortId = stored.battle.id.replaceAll("-", "").slice(0, 10).toLowerCase();
      const baseRef = await resolveBattleBaseRef(workspace.cwd);
      stored.secrets.baseCommit = baseRef;
      for (const side of ["A", "B"] as const) {
        const slug = `arena-${shortId}-${side.toLowerCase()}`;
        const worktree = await this.dependencies.createWorktree({
          cwd: workspace.cwd,
          worktreeSlug: slug,
          branchName: slug,
          refName: baseRef,
          action: "branch-off",
          title: titleFromPrompt(input.prompt),
          internal: true,
          runSetup: false,
          paseoHome: this.dependencies.paseoHome,
        });
        createdWorkspaceIds.push(worktree.workspace.workspaceId);
        stored.secrets[side].worktreePath = worktree.worktree.worktreePath;
        stored.secrets[side].agentCwd = worktree.workspace.cwd;
        stored.battle.sides[side].workspaceId = worktree.workspace.workspaceId;
        await copyWorkingTreeState(
          workspace.worktreeRoot ?? workspace.mainRepoRoot ?? workspace.cwd,
          worktree.worktree.worktreePath,
        );
        stored.secrets[side].baselineWorktreeFingerprint = await fingerprintVisibleWorktree(
          worktree.worktree.worktreePath,
        );
        const launch = await writeArenaOpenCodeConfig({
          paseoHome: this.dependencies.paseoHome,
          key: `${shortId}-${side.toLowerCase()}`,
          modelToken: stored.secrets[side].modelToken,
          modelLabel: sideLabel(side),
          proxyBaseUrl: this.proxy.openAiBaseUrl,
          inferenceToken: stored.secrets[side].modelToken,
        });
        stored.secrets[side].configPath = launch.configPath;
      }

      const sourceRows = source
        ? await this.dependencies.agentManager.getTimelineRows(source.id)
        : [];
      const forkContext = source
        ? buildAgentForkContextAttachment({
            rows: sourceRows,
            agentTitle: source.config.title,
            cwd: source.cwd,
          }).attachment.text
        : undefined;
      const sideSystemPrompt = forkContext
        ? `${BATTLE_IDENTITY_INSTRUCTION}\n\n${forkContext}`
        : BATTLE_IDENTITY_INSTRUCTION;
      const agents = await Promise.all(
        (["A", "B"] as const).map(async (side) => {
          const sideWorkspaceId = stored.battle.sides[side].workspaceId;
          const cwd = stored.secrets[side].agentCwd;
          const configPath = stored.secrets[side].configPath;
          if (!sideWorkspaceId || !cwd || !configPath)
            throw new Error(`Side ${side} is incomplete`);
          const agent = await this.dependencies.agentManager.createAgent(
            {
              provider: "opencode",
              cwd,
              model: `arena/${stored.secrets[side].modelToken}`,
              title: source?.config.title ?? titleFromPrompt(input.prompt),
              systemPrompt: sideSystemPrompt,
            },
            undefined,
            {
              workspaceId: sideWorkspaceId,
              initialTitle: source?.config.title ?? titleFromPrompt(input.prompt),
              labels: {
                ...source?.labels,
                arenaManaged: "true",
                arenaMode: "battle",
                arenaBattleId: stored.battle.id,
                arenaSide: side,
              },
              env: {
                OPENCODE_CONFIG: configPath,
                ARENA_INFERENCE_TOKEN: stored.secrets[side].modelToken,
              },
              timelineRows: sourceRows,
            },
          );
          createdAgentIds.push(agent.id);
          stored.battle.sides[side].agentId = agent.id;
          return { side, agent };
        }),
      );

      stored.battle.status = "running";
      stored.battle.updatedAt = now();
      for (const side of ["A", "B"] as const) stored.battle.sides[side].status = "running";
      await Promise.all(
        agents.map(async ({ side, agent }) => {
          const rows = await this.dependencies.agentManager.getTimelineRows(agent.id);
          stored.secrets[side].baselineTimelineSeq = rows.at(-1)?.seq ?? 0;
        }),
      );
      if (source) {
        await this.dependencies.agentManager.appendTimelineItem(source.id, {
          type: "user_message",
          text: input.prompt.trim(),
        });
      }
      await this.persistAndEmit(stored);

      for (const { side, agent } of agents) this.monitorSide(stored.battle.id, side, agent.id);
      await Promise.all(
        agents.map(({ agent }) =>
          sendPromptToAgent({
            agentManager: this.dependencies.agentManager,
            agentStorage: this.dependencies.agentStorage,
            agentId: agent.id,
            prompt: input.prompt.trim(),
            logger: this.dependencies.logger,
          }).then(() => waitForAgentRunStartWithTimeout(this.dependencies.agentManager, agent.id)),
        ),
      );
      return cloneBattle(stored.battle);
    } catch (error) {
      stored.battle.status = "error";
      stored.battle.updatedAt = now();
      for (const side of ["A", "B"] as const) {
        if (!isSideTerminal(stored.battle.sides[side].status)) {
          stored.battle.sides[side].status = "error";
          stored.battle.sides[side].error = error instanceof Error ? error.message : String(error);
        }
      }
      await this.proxy.stop(stored.battle.id).catch(() => undefined);
      await Promise.allSettled(
        createdAgentIds.map((agentId) =>
          archiveAgentCommand(
            {
              agentManager: this.dependencies.agentManager,
              agentStorage: this.dependencies.agentStorage,
              logger: this.dependencies.logger,
            },
            agentId,
          ),
        ),
      );
      await Promise.allSettled(
        createdWorkspaceIds.map((workspaceId) => this.dependencies.archiveWorkspace(workspaceId)),
      );
      await this.persistAndEmit(stored);
      throw error;
    }
  }

  async runSingleTurn(input: {
    agentId?: string;
    workspaceId: string;
    prompt: string;
    thinkingLevel: ArenaThinkingLevel;
  }): Promise<{ agentId: string; workspaceId: string }> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    let agent = input.agentId ? this.requireIdleSource(input.agentId, input.workspaceId) : null;
    if (agent) await this.requireEligibleArenaSource(agent);
    if (!isReusableSingleAgent(agent)) {
      const source = agent;
      const sourceRows = source
        ? await this.dependencies.agentManager.getTimelineRows(source.id)
        : [];
      const forkContext = source
        ? buildAgentForkContextAttachment({
            rows: sourceRows,
            agentTitle: source.config.title,
            cwd: source.cwd,
          }).attachment.text
        : undefined;
      const key = `single-${randomUUID().replaceAll("-", "")}`;
      const launch = await writeArenaOpenCodeConfig({
        paseoHome: this.dependencies.paseoHome,
        key,
        modelToken: "single",
        modelLabel: "Single agent",
        proxyBaseUrl: this.proxy.openAiBaseUrl,
        inferenceToken: singleInferenceToken(this.proxy.token),
      });
      agent = await this.dependencies.agentManager.createAgent(
        {
          provider: "opencode",
          cwd: workspace.cwd,
          model: "arena/single",
          thinkingOptionId: input.thinkingLevel,
          title: source?.config.title ?? titleFromPrompt(input.prompt),
          ...(forkContext ? { systemPrompt: forkContext } : {}),
        },
        undefined,
        {
          workspaceId: workspace.workspaceId,
          initialTitle: source?.config.title ?? titleFromPrompt(input.prompt),
          labels: singleAgentLabels(source),
          env: launch.env,
          timelineRows: sourceRows,
        },
      );
    } else {
      if (!agent) throw new Error("Reusable Arena single agent is missing");
      await this.dependencies.agentManager.setAgentModel(agent.id, "arena/single");
      await this.dependencies.agentManager.setAgentThinkingOption(agent.id, input.thinkingLevel);
    }
    await sendPromptToAgent({
      agentManager: this.dependencies.agentManager,
      agentStorage: this.dependencies.agentStorage,
      agentId: agent.id,
      prompt: input.prompt.trim(),
      logger: this.dependencies.logger,
    });
    await waitForAgentRunStartWithTimeout(this.dependencies.agentManager, agent.id);
    if (input.agentId && input.agentId !== agent.id) await this.archiveAgent(input.agentId);
    return { agentId: agent.id, workspaceId: workspace.workspaceId };
  }

  async getBattle(id: string): Promise<ArenaBattle> {
    return this.withMutation(id, async () => {
      const stored = await this.requireStored(id);
      const proxyState = await this.proxy.getBattle(id).catch(() => null);
      if (proxyState) {
        const priorState = JSON.stringify({
          decision: stored.battle.decision,
          winningSide: stored.battle.winningSide,
          decidedEarly: stored.battle.decidedEarly,
          decidedAt: stored.battle.decidedAt,
          reveal: stored.battle.reveal,
          comparison: stored.battle.comparison,
        });
        applyProxyDecision(stored.battle, proxyState);
        const nextState = JSON.stringify({
          decision: stored.battle.decision,
          winningSide: stored.battle.winningSide,
          decidedEarly: stored.battle.decidedEarly,
          decidedAt: stored.battle.decidedAt,
          reveal: stored.battle.reveal,
          comparison: stored.battle.comparison,
        });
        if (priorState !== nextState) {
          stored.battle.updatedAt = now();
          await this.persistAndEmit(stored);
        }
      }
      if (
        stored.battle.decision === null &&
        stored.battle.sides.A.status === "completed" &&
        stored.battle.sides.B.status === "completed" &&
        stored.battle.comparison.status === "unavailable" &&
        (stored.battle.comparison.reason === LEGACY_NO_DIFF_REASON ||
          stored.battle.comparison.reason === NO_EDITS_REASON) &&
        stored.secrets.comparisonDetectionVersion !== COMPARISON_DETECTION_VERSION
      ) {
        await this.prepareBattleComparison(stored);
      }
      return cloneBattle(stored.battle);
    });
  }

  async listBattles(filter?: { agentId?: string; workspaceId?: string }): Promise<ArenaBattle[]> {
    return (await this.store.list())
      .map((record) => record.battle)
      .filter((battle) => {
        const agentIds = [battle.sourceAgentId, battle.sides.A.agentId, battle.sides.B.agentId];
        const workspaceIds = [
          battle.sourceWorkspaceId,
          battle.sides.A.workspaceId,
          battle.sides.B.workspaceId,
        ];
        return (
          (!filter?.agentId || agentIds.includes(filter.agentId)) &&
          (!filter?.workspaceId || workspaceIds.includes(filter.workspaceId))
        );
      })
      .map(cloneBattle);
  }

  async vote(id: string, decision: "A" | "B" | "tie"): Promise<ArenaBattle> {
    return this.withMutation(id, async () => {
      const stored = await this.requireStored(id);
      if (stored.battle.decision) throw new Error("Battle has already been decided");
      await Promise.all(
        (["A", "B"] as const).map((side) => this.captureSideTranscript(stored, side)),
      );
      if (
        decision === "tie" &&
        !(["A", "B"] as const).every((side) => stored.battle.sides[side].status === "completed")
      ) {
        throw new Error("Both sides must finish successfully before recording a tie");
      }
      const winningSide: ArenaBattleSideId = decision === "tie" ? "A" : decision;
      if (stored.battle.sides[winningSide].status !== "completed") {
        throw new Error(`Side ${winningSide} can be selected only after it finishes successfully`);
      }
      // Completion notifications are retried here so a transient proxy outage at
      // turn completion cannot leave an otherwise valid battle unvotable.
      await this.syncTerminalSides(stored);
      const proxyState = await this.proxy.vote(id, decision);
      applyProxyDecision(stored.battle, proxyState);
      stored.battle.status = "decided";
      stored.battle.updatedAt = now();
      const loserSide: ArenaBattleSideId = winningSide === "A" ? "B" : "A";
      const winningWorkspaceId = stored.battle.sides[winningSide].workspaceId;
      if (!winningWorkspaceId) throw new Error(`Winning side ${winningSide} has no workspace`);
      await this.dependencies.setWorkspaceInternal(winningWorkspaceId, false);
      if (stored.battle.decidedEarly) {
        await this.cancelAndArchiveSide(stored, loserSide);
        stored.battle.comparison = {
          status: "unavailable",
          reason: "Comparison unavailable—battle decided early",
        };
      } else {
        await this.archiveSide(stored, loserSide);
      }
      if (stored.battle.sourceAgentId) await this.archiveAgent(stored.battle.sourceAgentId);
      await this.appendBattleCard(stored, winningSide, decision);
      await this.persistAndEmit(stored);
      return cloneBattle(stored.battle);
    });
  }

  async stop(id: string): Promise<ArenaBattle> {
    return this.withMutation(id, async () => {
      const stored = await this.requireStored(id);
      if (stored.battle.decision) throw new Error("Battle has already been decided");
      const proxyState = await this.proxy.stop(id);
      applyProxyDecision(stored.battle, proxyState);
      stored.battle.status = "stopped";
      stored.battle.updatedAt = now();
      await Promise.all(
        (["A", "B"] as const).map((side) => this.cancelAndArchiveSide(stored, side)),
      );
      await this.persistAndEmit(stored);
      return cloneBattle(stored.battle);
    });
  }

  private requireIdleSource(agentId: string, workspaceId: string): ManagedAgent {
    const agent = this.dependencies.agentManager.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.workspaceId !== workspaceId)
      throw new Error("Agent does not belong to the workspace");
    if (this.dependencies.agentManager.hasInFlightRun(agentId)) {
      throw new Error("Battle mode cannot change while an agent turn is running");
    }
    return agent;
  }

  private async requireEligibleArenaSource(source: ManagedAgent): Promise<void> {
    const activeBattle = (await this.store.list()).find((record) => {
      const battle = record.battle;
      if (battle.decision !== null || battle.status === "error") return false;
      return (
        battle.sourceAgentId === source.id ||
        battle.sides.A.agentId === source.id ||
        battle.sides.B.agentId === source.id
      );
    });
    if (activeBattle) {
      throw new Error("Decide the current battle before continuing this agent");
    }
    const battleId = source.labels.arenaBattleId;
    const side = source.labels.arenaSide;
    if (!battleId || (side !== "A" && side !== "B")) return;
    const stored = await this.store.get(battleId);
    if (!stored?.battle.decision) {
      throw new Error("Decide the current battle before continuing this agent");
    }
    if (stored.battle.winningSide !== side) {
      throw new Error("Only the winning battle agent can continue the chat");
    }
  }

  private async requireWorkspace(workspaceId: string): Promise<PersistedWorkspaceRecord> {
    const workspace = await this.dependencies.getWorkspace(workspaceId);
    if (!workspace || workspace.archivedAt)
      throw new Error(`Active workspace not found: ${workspaceId}`);
    return workspace;
  }

  private monitorSide(battleId: string, side: ArenaBattleSideId, agentId: string): void {
    const key = `${battleId}:${side}`;
    this.monitors.get(key)?.();
    const unsubscribe = this.dependencies.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        if (event.event.type === "turn_completed") {
          unsubscribe();
          this.monitors.delete(key);
          void this.finishSide(battleId, side, "completed");
        } else if (event.event.type === "turn_failed") {
          unsubscribe();
          this.monitors.delete(key);
          void this.finishSide(battleId, side, "error", event.event.error);
        } else if (event.event.type === "turn_canceled") {
          unsubscribe();
          this.monitors.delete(key);
          void this.finishSide(battleId, side, "cancelled", event.event.reason);
        }
      },
      { agentId, replayState: false },
    );
    this.monitors.set(key, unsubscribe);
  }

  private async finishSide(
    id: string,
    side: ArenaBattleSideId,
    status: "completed" | "cancelled" | "error",
    error?: string,
  ): Promise<void> {
    await this.withMutation(id, async () => {
      const stored = await this.requireStored(id);
      if (isSideTerminal(stored.battle.sides[side].status)) return;
      let resolvedStatus = status;
      let resolvedError = error;
      if (status === "error") {
        const agentId = stored.battle.sides[side].agentId;
        if (agentId) {
          try {
            const rows = await this.dependencies.agentManager.getTimelineRows(agentId);
            if (
              hasSubstantiveAssistantReply(
                rows,
                stored.secrets[side].baselineTimelineSeq ?? Number.MAX_SAFE_INTEGER,
              )
            ) {
              resolvedStatus = "completed";
              resolvedError = undefined;
            }
          } catch (timelineError) {
            this.dependencies.logger.warn(
              { err: timelineError, battleId: id, side },
              "Unable to verify Arena side reply after turn failure",
            );
          }
        }
      }
      await this.captureSideTranscript(stored, side);
      stored.battle.sides[side].status = resolvedStatus;
      stored.battle.sides[side].finishedAt = now();
      stored.battle.sides[side].error = resolvedError ?? null;
      stored.battle.updatedAt = now();
      if (resolvedStatus === "completed") {
        await this.proxy.markComplete(id, side).catch((proxyError) => {
          this.dependencies.logger.warn(
            { err: proxyError, battleId: id, side },
            "Arena completion report failed",
          );
        });
      }
      const bothTerminal = (["A", "B"] as const).every((candidate) =>
        isSideTerminal(stored.battle.sides[candidate].status),
      );
      if (!bothTerminal || stored.battle.decision) {
        await this.persistAndEmit(stored);
        return;
      }
      const successfulSides = (["A", "B"] as const).filter(
        (candidate) => stored.battle.sides[candidate].status === "completed",
      );
      if (successfulSides.length === 0) {
        stored.battle.status = "error";
        stored.battle.comparison = {
          status: "unavailable",
          reason: "No agent produced a usable response",
        };
        await this.proxy.stop(id).catch(() => undefined);
        await Promise.all(
          (["A", "B"] as const).map((candidate) => this.archiveSide(stored, candidate)),
        );
        await this.persistAndEmit(stored);
        return;
      }
      stored.battle.status = "awaiting_vote";
      if (successfulSides.length === 1) {
        stored.battle.comparison = {
          status: "unavailable",
          reason: "Comparison unavailable—one agent failed",
        };
        const failedSide: ArenaBattleSideId = successfulSides[0] === "A" ? "B" : "A";
        await this.archiveSide(stored, failedSide);
        await this.persistAndEmit(stored);
        return;
      }
      await this.persistAndEmit(stored);
      await this.prepareBattleComparison(stored);
    });
  }

  private async prepareBattleComparison(stored: StoredArenaBattle): Promise<void> {
    const rootA = stored.secrets.A.worktreePath;
    const rootB = stored.secrets.B.worktreePath;
    if (!rootA || !rootB) throw new Error("Battle worktrees are missing");
    if (
      !stored.secrets.A.baselineWorktreeFingerprint ||
      !stored.secrets.B.baselineWorktreeFingerprint
    ) {
      const sourceWorkspace = await this.dependencies.getWorkspace(stored.battle.sourceWorkspaceId);
      if (sourceWorkspace) {
        const sourceRoot =
          sourceWorkspace.worktreeRoot ?? sourceWorkspace.mainRepoRoot ?? sourceWorkspace.cwd;
        const fallbackFingerprint = await fingerprintVisibleWorktree(sourceRoot);
        stored.secrets.A.baselineWorktreeFingerprint ??= fallbackFingerprint;
        stored.secrets.B.baselineWorktreeFingerprint ??= fallbackFingerprint;
      }
    }
    const [diff, sideAHasEdits, sideBHasEdits] = await Promise.all([
      buildBoundedBattleDiff(rootA, rootB),
      hasBattleFileEdits(
        rootA,
        stored.secrets.baseCommit,
        stored.secrets.A.baselineWorktreeFingerprint,
      ),
      hasBattleFileEdits(
        rootB,
        stored.secrets.baseCommit,
        stored.secrets.B.baselineWorktreeFingerprint,
      ),
    ]);
    stored.secrets.comparisonDetectionVersion = COMPARISON_DETECTION_VERSION;
    stored.battle.diff = diff;
    const hasEdits = sideAHasEdits || sideBHasEdits;
    if (hasEdits) {
      stored.battle.comparison = { status: "generating" };
      stored.battle.updatedAt = now();
      await this.persistAndEmit(stored);
    }
    try {
      await this.syncTerminalSides(stored);
      const proxyState = await this.proxy.startComparison(
        stored.battle.id,
        stored.battle.prompt,
        renderBattleComparisonInput(stored.battle.diff, hasEdits),
        stored.battle.diff.changedFiles,
        hasEdits,
      );
      stored.battle.comparison = proxyState.comparison;
      stored.battle.updatedAt = now();
      await this.persistAndEmit(stored);
      if (hasEdits) void this.pollComparison(stored.battle.id);
    } catch (comparisonError) {
      stored.battle.comparison = {
        status: "error",
        error: comparisonError instanceof Error ? comparisonError.message : String(comparisonError),
      };
      stored.battle.updatedAt = now();
      await this.persistAndEmit(stored);
    }
  }

  private async pollComparison(id: string): Promise<void> {
    for (let attempt = 0; attempt < COMPARISON_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, COMPARISON_POLL_INTERVAL_MS));
      const state = await this.proxy.getBattle(id).catch(() => null);
      if (!state) continue;
      if (state.comparison.status === "pending" || state.comparison.status === "generating")
        continue;
      await this.withMutation(id, async () => {
        const stored = await this.requireStored(id);
        stored.battle.comparison = state.comparison;
        stored.battle.updatedAt = now();
        await this.persistAndEmit(stored);
      });
      return;
    }
  }

  private async cancelAndArchiveSide(
    stored: StoredArenaBattle,
    side: ArenaBattleSideId,
  ): Promise<void> {
    const agentId = stored.battle.sides[side].agentId;
    if (agentId && this.dependencies.agentManager.getAgent(agentId)) {
      await cancelAgentRunCommand(
        {
          agentManager: this.dependencies.agentManager,
          logger: this.dependencies.logger,
        },
        agentId,
      ).catch(() => undefined);
    }
    if (!isSideTerminal(stored.battle.sides[side].status)) {
      stored.battle.sides[side].status = "cancelled";
      stored.battle.sides[side].finishedAt = now();
    }
    await this.archiveSide(stored, side);
  }

  private async syncTerminalSides(stored: StoredArenaBattle): Promise<void> {
    await Promise.all(
      (["A", "B"] as const)
        .filter((side) => stored.battle.sides[side].status === "completed")
        .map((side) => this.proxy.markComplete(stored.battle.id, side)),
    );
  }

  private async archiveSide(stored: StoredArenaBattle, side: ArenaBattleSideId): Promise<void> {
    await this.captureSideTranscript(stored, side);
    const agentId = stored.battle.sides[side].agentId;
    if (agentId) await this.archiveAgent(agentId);
    const workspaceId = stored.battle.sides[side].workspaceId;
    if (workspaceId)
      await this.dependencies.archiveWorkspace(workspaceId).catch((error) => {
        this.dependencies.logger.warn(
          { err: error, workspaceId },
          "Failed to archive Arena workspace",
        );
      });
  }

  private async archiveAgent(agentId: string): Promise<void> {
    await archiveAgentCommand(
      {
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        logger: this.dependencies.logger,
      },
      agentId,
    ).catch((error) => {
      this.dependencies.logger.warn({ err: error, agentId }, "Failed to archive Arena agent");
    });
  }

  private async captureSideTranscript(
    stored: StoredArenaBattle,
    side: ArenaBattleSideId,
  ): Promise<void> {
    const entry = stored.battle.sides[side];
    if (!entry.agentId || entry.transcript?.length) return;
    try {
      const rows = await this.dependencies.agentManager.getTimelineRows(entry.agentId);
      entry.transcript = selectBattleTranscriptRows(
        rows,
        stored.secrets[side].baselineTimelineSeq ?? Number.MAX_SAFE_INTEGER,
      );
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, battleId: stored.battle.id, side },
        "Failed to retain Arena side transcript",
      );
    }
  }

  private async appendBattleCard(
    stored: StoredArenaBattle,
    winningSide: ArenaBattleSideId,
    decision: Exclude<ArenaBattleDecision, "stopped">,
  ): Promise<void> {
    const winnerId = stored.battle.sides[winningSide].agentId;
    if (!winnerId || !stored.battle.reveal) return;
    await this.dependencies.agentManager.appendTimelineItem(
      winnerId,
      {
        type: "tool_call",
        callId: `arena-${stored.battle.id}`,
        name: "arena_battle",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: `Battle · ${decision === "tie" ? "Tie (A advanced)" : `${winningSide} selected`}`,
          text: `${stored.battle.reveal.A} vs ${stored.battle.reveal.B}`,
          icon: "sparkles",
        },
        metadata: { arenaBattleId: stored.battle.id },
      },
      {
        timestamp: stored.battle.sides[winningSide].finishedAt ?? stored.battle.updatedAt,
      },
    );
  }

  private async persistAndEmit(stored: StoredArenaBattle): Promise<void> {
    await this.store.put(stored);
    this.dependencies.emitUpdate(cloneBattle(stored.battle));
  }

  private async requireStored(id: string): Promise<StoredArenaBattle> {
    const stored = await this.store.get(id);
    if (!stored) throw new Error(`Battle not found: ${id}`);
    return stored;
  }

  private async withMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = BATTLE_MUTATION_TAILS.get(id) ?? Promise.resolve();
    let resolveTail: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    const tail = previous.then(() => current);
    BATTLE_MUTATION_TAILS.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      resolveTail();
      if (BATTLE_MUTATION_TAILS.get(id) === tail) BATTLE_MUTATION_TAILS.delete(id);
    }
  }
}
