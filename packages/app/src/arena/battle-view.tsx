import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
  type ViewStyle,
} from "react-native";
import { ChevronDown, ChevronRight, Swords } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ArenaBattle,
  ArenaBattleDiff,
  ArenaBattleSideId,
  ArenaBattleTranscriptRow,
  ArenaDiffFile,
} from "@getpaseo/protocol/arena";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { AgentStreamView } from "@/agent-stream/view";
import { RunningTurnIndicator } from "@/agent-stream/turn-footer";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, type Agent, useSessionStore } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import { reduceStreamUpdate, type StreamItem } from "@/types/stream";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  arenaBattleKey,
  findArenaBattleForAgent,
  findArenaBattleForWorkspace,
  useArenaStore,
} from "@/arena/store";
import { useArenaSupported } from "@/arena/capability";

const EMPTY_STREAM: StreamItem[] = [];
const EMPTY_PERMISSIONS = new Map<string, PendingPermission>();
const TERMINAL_SIDE_STATUSES = new Set(["completed", "cancelled", "error"]);

function diffFileHeaderStyle({ pressed }: PressableStateCallbackType) {
  return [styles.diffFileHeader, pressed ? styles.pressed : null];
}

function cardHeaderStyle({ pressed }: PressableStateCallbackType) {
  return [styles.cardHeader, pressed ? styles.pressed : null];
}

function isTerminalSide(status: ArenaBattle["sides"][ArenaBattleSideId]["status"]): boolean {
  return TERMINAL_SIDE_STATUSES.has(status);
}

function isArenaBattleCard(item: StreamItem): boolean {
  return (
    item.kind === "tool_call" &&
    item.payload.source === "agent" &&
    item.payload.data.name === "arena_battle"
  );
}

function currentBattleResponse(
  items: StreamItem[],
  prompt: string,
  battleCreatedAt: string,
): StreamItem[] {
  const normalizedPrompt = prompt.trim();
  const earliestBattleMessage = Date.parse(battleCreatedAt) - 1_000;
  let startIndex = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (
      item?.kind === "user_message" &&
      item.text.trim() === normalizedPrompt &&
      item.timestamp.getTime() >= earliestBattleMessage
    ) {
      startIndex = index;
      break;
    }
  }
  return startIndex >= 0 ? items.slice(startIndex + 1) : EMPTY_STREAM;
}

function retainedBattleResponse(
  rows: ArenaBattleTranscriptRow[] | undefined,
  prompt: string,
  battleCreatedAt: string,
): StreamItem[] {
  if (!rows?.length) return EMPTY_STREAM;
  let items: StreamItem[] = [];
  for (const row of rows) {
    const event = {
      type: "timeline",
      provider: "opencode",
      item: row.item,
    } as unknown as Extract<AgentStreamEventPayload, { type: "timeline" }>;
    items = reduceStreamUpdate(items, event, new Date(row.timestamp), {
      source: "canonical",
      timelineCursor: { epoch: "arena-retained", seq: row.seq },
    });
  }
  return currentBattleResponse(items, prompt, battleCreatedAt);
}

function emptyBattleThreadMessage(
  status: ArenaBattle["sides"][ArenaBattleSideId]["status"],
): string {
  if (status === "completed") {
    return "The agent finished, but no response was recorded for this battle.";
  }
  if (status === "cancelled") {
    return "This battle agent was stopped before producing a response.";
  }
  if (status === "error") {
    return "This battle agent failed before producing a response.";
  }
  return "Waiting for this battle agent to respond…";
}

function formatModelName(model: string): string {
  if (model === "z-ai/glm-5.2") return "GLM 5.2";
  if (model === "qwen/qwen3.8-max") return "Qwen 3.8 Max";
  if (model.includes("deepseek-v4-pro")) return "DeepSeek V4 Pro";
  return model.replace(/^~?[^/]+\//, "");
}

function battleLabel(battle: ArenaBattle): string {
  if (!battle.reveal) return "Battle";
  const selected = battle.winningSide ? formatModelName(battle.reveal[battle.winningSide]) : null;
  let decision = "Stopped";
  if (battle.decision === "tie") {
    decision = `Tie · A advanced (${selected ?? formatModelName(battle.reveal.A)})`;
  } else if (battle.winningSide) {
    decision = `${battle.winningSide} selected (${selected})`;
  }
  return `Battle · ${decision} · ${formatModelName(
    battle.reveal.A,
  )} vs ${formatModelName(battle.reveal.B)}`;
}

function summaryCardLabel(supported: boolean, battle: ArenaBattle | null): string {
  if (!supported) return "Battle · update host";
  return battle ? battleLabel(battle) : "Loading battle…";
}

function useBattleById(
  serverId: string,
  battleId: string,
  client: DaemonClient | null,
  enabled = true,
): ArenaBattle | null {
  const battle = useArenaStore(
    (state) => state.battles[arenaBattleKey(serverId, battleId)] ?? null,
  );
  const upsertBattle = useArenaStore((state) => state.upsertBattle);
  const comparisonNeedsRefresh =
    enabled &&
    (!battle ||
      battle.comparison.status === "pending" ||
      battle.comparison.status === "generating" ||
      (battle.comparison.status === "unavailable" &&
        battle.comparison.reason === "AI comparison skipped—no file differences"));
  const shouldPoll = battle !== null;
  useEffect(() => {
    if (!comparisonNeedsRefresh || !client) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const loaded = await client.getArenaBattle(battleId);
        if (!cancelled) upsertBattle(serverId, loaded);
      } catch {
        // A historical card can outlive a disconnected host.
      }
    };
    void refresh();
    const interval = shouldPoll ? setInterval(() => void refresh(), 2_000) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [battleId, client, comparisonNeedsRefresh, serverId, shouldPoll, upsertBattle]);
  return enabled ? battle : null;
}

export function useArenaBattleForAgent(serverId: string, agentId: string): ArenaBattle | null {
  const client = useHostRuntimeClient(serverId);
  const supported = useArenaSupported(serverId);
  const battle = useArenaStore((state) =>
    findArenaBattleForAgent(state.battles, serverId, agentId),
  );
  const upsertBattle = useArenaStore((state) => state.upsertBattle);
  const needsRefresh =
    !battle ||
    battle.decision === null ||
    battle.comparison.status === "pending" ||
    battle.comparison.status === "generating";
  const battleId = battle?.id ?? null;
  useEffect(() => {
    if (!client || !supported || !needsRefresh) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (battleId) {
          const loaded = await client.getArenaBattle(battleId);
          if (!cancelled) upsertBattle(serverId, loaded);
          return;
        }
        const battles = await client.listArenaBattles({ agentId });
        if (cancelled) return;
        for (const loaded of battles) upsertBattle(serverId, loaded);
      } catch {
        // The normal agent view remains usable if Arena history cannot load.
      }
    };
    void load();
    const interval = battleId ? setInterval(() => void load(), 2_000) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [agentId, battleId, client, needsRefresh, serverId, supported, upsertBattle]);
  return supported ? battle : null;
}

export function useArenaBattleForWorkspace(
  serverId: string,
  workspaceId: string,
): ArenaBattle | null {
  const client = useHostRuntimeClient(serverId);
  const supported = useArenaSupported(serverId);
  const battle = useArenaStore((state) =>
    findArenaBattleForWorkspace(state.battles, serverId, workspaceId),
  );
  const upsertBattle = useArenaStore((state) => state.upsertBattle);
  const battleId = battle?.id ?? null;
  const needsRefresh =
    !battle ||
    battle.decision === null ||
    battle.comparison.status === "pending" ||
    battle.comparison.status === "generating";
  useEffect(() => {
    if (!client || !supported || !needsRefresh) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (battleId) {
          const loaded = await client.getArenaBattle(battleId);
          if (!cancelled) upsertBattle(serverId, loaded);
          return;
        }
        const battles = await client.listArenaBattles({ workspaceId });
        if (cancelled) return;
        for (const loaded of battles) upsertBattle(serverId, loaded);
      } catch {
        // The draft remains usable if Arena history cannot load.
      }
    };
    void load();
    const interval = battleId ? setInterval(() => void load(), 2_000) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [battleId, client, needsRefresh, serverId, supported, upsertBattle, workspaceId]);
  return supported ? battle : null;
}

function toScreenAgent(agent: Agent): AgentScreenAgent {
  return {
    serverId: agent.serverId,
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId,
    runtimeInfo: agent.runtimeInfo,
    features: agent.features,
    lastError: agent.lastError,
    projectPlacement: agent.projectPlacement,
  };
}

const ArenaAgentThread = memo(function ArenaAgentThread({
  serverId,
  agentId,
  battlePrompt,
  battleCreatedAt,
  sideStatus,
  hideBattleCards = false,
  retainedTranscript,
}: {
  serverId: string;
  agentId: string | null;
  battlePrompt: string;
  battleCreatedAt: string;
  sideStatus: ArenaBattle["sides"][ArenaBattleSideId]["status"];
  hideBattleCards?: boolean;
  retainedTranscript?: ArenaBattleTranscriptRow[];
}) {
  const client = useHostRuntimeClient(serverId);
  const directoryAgent = useSessionStore((state) => {
    if (!agentId) return null;
    const session = state.sessions[serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
  });
  const [fetchedAgent, setFetchedAgent] = useState<Agent | null>(null);
  const [timelineFetchCompleted, setTimelineFetchCompleted] = useState(false);
  const streamTail = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamTail.get(agentId) : undefined,
  );
  const streamHead = useSessionStore((state) =>
    agentId ? state.sessions[serverId]?.agentStreamHead.get(agentId) : undefined,
  );
  const turnPresentation = useSessionStore(
    useShallow((state) =>
      agentId
        ? selectAgentTurnPresentation(state.sessions[serverId], agentId)
        : {
            isActive: false,
            isCancelling: false,
            startedAt: null,
            turnId: null,
          },
    ),
  );
  const pendingPermissions = useSessionStore(
    useShallow((state) => {
      if (!agentId) return EMPTY_PERMISSIONS;
      const pending = state.sessions[serverId]?.pendingPermissions;
      if (!pending) return EMPTY_PERMISSIONS;
      const filtered = new Map<string, PendingPermission>();
      for (const [key, permission] of pending) {
        if (permission.agentId === agentId) filtered.set(key, permission);
      }
      return filtered;
    }),
  );
  const agent = directoryAgent ?? fetchedAgent;
  const sideIsActive = sideStatus === "preparing" || sideStatus === "running";
  const displayedTurnPresentation = useMemo(
    () =>
      sideIsActive && !turnPresentation.isActive
        ? {
            ...turnPresentation,
            isActive: true,
            startedAt: turnPresentation.startedAt ?? new Date(battleCreatedAt),
          }
        : turnPresentation,
    [battleCreatedAt, sideIsActive, turnPresentation],
  );

  useEffect(() => {
    if (!agentId || !client || directoryAgent || fetchedAgent) return;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await client.fetchAgent({ agentId });
        if (!result || cancelled) return;
        const normalized = normalizeAgentSnapshot(result.agent, serverId);
        setFetchedAgent(
          applyLegacyDaemonWorkspaceOwnership({
            serverId,
            agent: { ...normalized, projectPlacement: result.project },
          }),
        );
      } catch {
        // The archived side may have been pruned after its battle was retained.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, client, directoryAgent, fetchedAgent, serverId]);

  useEffect(() => {
    setTimelineFetchCompleted(false);
  }, [agentId]);

  useEffect(() => {
    if (!agentId || !client) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        await getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, {
          direction: "tail",
          limit: 400,
        });
      } catch {
        // A side can disappear if an old battle's archived agent was pruned.
      } finally {
        if (!cancelled) setTimelineFetchCompleted(true);
      }
    };
    void refresh();
    const interval = sideIsActive ? setInterval(() => void refresh(), 2_000) : null;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [agentId, client, serverId, sideIsActive]);

  const tail = useMemo(() => {
    const response = currentBattleResponse(
      streamTail ?? EMPTY_STREAM,
      battlePrompt,
      battleCreatedAt,
    );
    return hideBattleCards ? response.filter((item) => !isArenaBattleCard(item)) : response;
  }, [battleCreatedAt, battlePrompt, hideBattleCards, streamTail]);
  const head = useMemo(() => {
    const response = (streamHead ?? EMPTY_STREAM).filter((item) => item.kind !== "user_message");
    return hideBattleCards ? response.filter((item) => !isArenaBattleCard(item)) : response;
  }, [hideBattleCards, streamHead]);
  const retained = useMemo(
    () => retainedBattleResponse(retainedTranscript, battlePrompt, battleCreatedAt),
    [battleCreatedAt, battlePrompt, retainedTranscript],
  );
  const displayedTail = tail.length > 0 || head.length > 0 ? tail : retained;

  if (!agentId || !agent) {
    if (sideIsActive) {
      return <RunningTurnIndicator inFlightTurnStartedAt={displayedTurnPresentation.startedAt} />;
    }
    if (retained.length > 0) {
      return (
        <ScrollView contentContainerStyle={styles.retainedTranscript}>
          {retained.map((item) =>
            item.kind === "assistant_message" ? (
              <MarkdownRenderer key={item.id} text={item.text} compact />
            ) : null,
          )}
        </ScrollView>
      );
    }
    return (
      <View style={styles.centered}>
        {!timelineFetchCompleted ? <ActivityIndicator /> : null}
        {timelineFetchCompleted ? (
          <Text style={styles.muted}>{emptyBattleThreadMessage(sideStatus)}</Text>
        ) : null}
      </View>
    );
  }

  if (displayedTail.length === 0 && head.length === 0 && !sideIsActive) {
    return (
      <View style={styles.centered}>
        {sideIsActive || !timelineFetchCompleted ? <ActivityIndicator /> : null}
        <Text style={styles.muted}>
          {timelineFetchCompleted
            ? emptyBattleThreadMessage(sideStatus)
            : "Loading this battle response…"}
        </Text>
      </View>
    );
  }

  return (
    <AgentStreamView
      agentId={agentId}
      serverId={serverId}
      context={toScreenAgent(agent)}
      streamItems={displayedTail}
      streamHead={head}
      pendingPermissions={pendingPermissions}
      turnPresentation={displayedTurnPresentation}
      readOnly
    />
  );
});

function lineStyle(line: string) {
  if (line.startsWith("+")) return styles.codeAdd;
  if (line.startsWith("-")) return styles.codeDelete;
  return styles.codeLine;
}

function omittedDiffMessage(file: ArenaDiffFile): string {
  if (file.status === "binary") return "Binary files differ";
  if (file.status === "type_changed") return "File type differs";
  if (file.status === "added_a") return "File exists only in A; content is binary or empty";
  if (file.status === "added_b") return "File exists only in B; content is binary or empty";
  return file.truncated ? "Text diff omitted because the file is too large" : "Content differs";
}

function occurrenceKeys(values: string[]): { key: string; value: string }[] {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const occurrence = occurrences.get(value) ?? 0;
    occurrences.set(value, occurrence + 1);
    return { key: `${value}:${occurrence}`, value };
  });
}

const ArenaDiffFileView = memo(function ArenaDiffFileView({
  file,
  expanded,
  onToggle,
}: {
  file: ArenaDiffFile;
  expanded: boolean;
  onToggle: (path: string) => void;
}) {
  const handleToggle = useCallback(() => onToggle(file.path), [file.path, onToggle]);
  const renderedHunks = useMemo(
    () =>
      file.hunks.map((hunk) => ({
        key: `${hunk.header}:${hunk.lines.join("\u0000")}`,
        header: hunk.header,
        lines: occurrenceKeys(hunk.lines),
      })),
    [file.hunks],
  );
  return (
    <View style={styles.diffFile}>
      <Pressable onPress={handleToggle} style={diffFileHeaderStyle}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Text numberOfLines={1} style={styles.diffPath}>
          {file.path}
        </Text>
        <Text style={styles.diffStats}>
          +{file.additions} −{file.deletions}
        </Text>
      </Pressable>
      {expanded ? (
        <ScrollView horizontal style={styles.codeScroll}>
          <View style={styles.codeBlock}>
            {renderedHunks.length === 0 ? (
              <Text style={styles.codeMuted}>{omittedDiffMessage(file)}</Text>
            ) : (
              renderedHunks.map((hunk) => (
                <View key={hunk.key}>
                  <Text style={styles.codeHeader}>{hunk.header}</Text>
                  {hunk.lines.map((line) => (
                    <Text key={line.key} style={lineStyle(line.value)}>
                      {line.value}
                    </Text>
                  ))}
                </View>
              ))
            )}
            {file.truncated ? <Text style={styles.codeMuted}>[file diff truncated]</Text> : null}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
});

function ArenaDiffView({ diff }: { diff: ArenaBattleDiff }) {
  const [expandedPath, setExpandedPath] = useState<string | null>(diff.files[0]?.path ?? null);
  const togglePath = useCallback(
    (path: string) => setExpandedPath((current) => (current === path ? null : path)),
    [],
  );
  return (
    <View style={styles.diffRoot}>
      <Text style={styles.sectionTitle}>
        A vs B diff · {diff.changedFiles} changed file
        {diff.changedFiles === 1 ? "" : "s"}
        {diff.truncated ? " · bounded" : ""}
      </Text>
      {diff.files.map((file) => (
        <ArenaDiffFileView
          key={file.path}
          file={file}
          expanded={expandedPath === file.path}
          onToggle={togglePath}
        />
      ))}
      {diff.files.length === 0 ? (
        <Text style={styles.muted}>No differences between A and B.</Text>
      ) : null}
    </View>
  );
}

function ComparisonSummary({ battle }: { battle: ArenaBattle }) {
  const comparison = battle.comparison;
  if (comparison.status === "pending" || comparison.status === "generating") {
    return (
      <View style={styles.summaryLoading}>
        <ActivityIndicator />
        <Text style={styles.muted}>Comparing the two implementations…</Text>
      </View>
    );
  }
  if (comparison.status === "completed") {
    return <MarkdownRenderer text={comparison.summary} compact />;
  }
  if (comparison.status === "unavailable") {
    return <Text style={styles.muted}>{comparison.reason}</Text>;
  }
  if (comparison.status === "error") {
    return <Text style={styles.errorText}>{comparison.error}</Text>;
  }
  return null;
}

function ArenaComparison({ battle }: { battle: ArenaBattle }) {
  if (!battle.diff && battle.comparison.status === "pending") return null;
  return (
    <ScrollView style={styles.comparison} contentContainerStyle={styles.comparisonContent}>
      {battle.diff ? <ArenaDiffView diff={battle.diff} /> : null}
      <View style={styles.summary}>
        <Text style={styles.sectionTitle}>AI comparison</Text>
        <ComparisonSummary battle={battle} />
      </View>
    </ScrollView>
  );
}

function SidePane({
  serverId,
  battle,
  side,
  action,
  onChoose,
  readOnly,
}: {
  serverId: string;
  battle: ArenaBattle;
  side: ArenaBattleSideId;
  action: ArenaBattleSideId | "tie" | "stop" | null;
  onChoose: (side: ArenaBattleSideId) => void;
  readOnly: boolean;
}) {
  const entry = battle.sides[side];
  const canChoose = entry.status === "completed" && battle.decision === null;
  const handleChoose = useCallback(() => onChoose(side), [onChoose, side]);
  return (
    <View style={styles.sidePane} testID={`arena-side-${side.toLowerCase()}`}>
      <View style={styles.sideHeader}>
        <View style={styles.sideIdentity}>
          <View style={styles.sideBadge}>
            <Text style={styles.sideBadgeText}>{side}</Text>
          </View>
          <Text style={styles.sideTitle}>Agent {side}</Text>
        </View>
        <Text style={[styles.statusText, entry.status === "error" && styles.statusError]}>
          {entry.status === "error" ? "failed · no response" : entry.status.replace("_", " ")}
        </Text>
      </View>
      <View style={styles.thread}>
        <ArenaAgentThread
          serverId={serverId}
          agentId={entry.agentId}
          battlePrompt={battle.prompt}
          battleCreatedAt={battle.createdAt}
          sideStatus={entry.status}
          hideBattleCards={readOnly}
          retainedTranscript={entry.transcript}
        />
      </View>
      {!readOnly ? (
        <View style={styles.chooseRow}>
          <Button
            variant={canChoose ? "default" : "secondary"}
            size="sm"
            disabled={!canChoose || action !== null}
            loading={action === side}
            onPress={handleChoose}
            testID={`arena-choose-${side.toLowerCase()}`}
          >
            Choose {side}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export const ArenaBattleView = memo(function ArenaBattleView({
  serverId,
  battle,
  toast,
  onDecided,
  readOnly = false,
  inline = false,
}: {
  serverId: string;
  battle: ArenaBattle;
  toast?: ToastApi;
  onDecided?: (battle: ArenaBattle) => void;
  readOnly?: boolean;
  inline?: boolean;
}) {
  const client = useHostRuntimeClient(serverId);
  const upsertBattle = useArenaStore((state) => state.upsertBattle);
  const [action, setAction] = useState<ArenaBattleSideId | "tie" | "stop" | null>(null);
  const bothTerminal =
    isTerminalSide(battle.sides.A.status) && isTerminalSide(battle.sides.B.status);
  const bothSuccessful =
    battle.sides.A.status === "completed" && battle.sides.B.status === "completed";
  const hasSuccessfulSide =
    battle.sides.A.status === "completed" || battle.sides.B.status === "completed";

  const decide = useCallback(
    async (decision: ArenaBattleSideId | "tie") => {
      if (!client || action) return;
      setAction(decision);
      try {
        const result = await client.voteArenaBattle(battle.id, decision);
        upsertBattle(serverId, result);
        if (result.decidedEarly) {
          toast?.show("Battle decided early, data marked accordingly.", {
            variant: "info",
          });
        }
        onDecided?.(result);
      } catch (error) {
        toast?.error(error instanceof Error ? error.message : "Failed to decide battle");
      } finally {
        setAction(null);
      }
    },
    [action, battle.id, client, onDecided, serverId, toast, upsertBattle],
  );

  const stop = useCallback(async () => {
    if (!client || action) return;
    setAction("stop");
    try {
      const result = await client.stopArenaBattle(battle.id);
      upsertBattle(serverId, result);
      onDecided?.(result);
    } catch (error) {
      toast?.error(error instanceof Error ? error.message : "Failed to stop battle");
    } finally {
      setAction(null);
    }
  }, [action, battle.id, client, onDecided, serverId, toast, upsertBattle]);
  const chooseTie = useCallback(() => {
    void decide("tie");
  }, [decide]);
  let rootStyle: ViewStyle = styles.root;
  if (readOnly) rootStyle = styles.readOnlyRoot;
  else if (inline) rootStyle = styles.inlineRoot;

  return (
    <View style={rootStyle}>
      {!readOnly ? (
        <View style={styles.battleHeader}>
          <View style={styles.titleRow}>
            <Swords size={18} />
            <Text style={styles.battleTitle}>Blind battle</Text>
          </View>
          <View style={styles.headerActions}>
            {(!bothTerminal || !hasSuccessfulSide) && battle.decision === null ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={action !== null}
                loading={action === "stop"}
                onPress={stop}
              >
                Stop both
              </Button>
            ) : null}
          </View>
        </View>
      ) : null}
      <View style={styles.sides}>
        <SidePane
          serverId={serverId}
          battle={battle}
          side="A"
          action={action}
          onChoose={decide}
          readOnly={readOnly}
        />
        <SidePane
          serverId={serverId}
          battle={battle}
          side="B"
          action={action}
          onChoose={decide}
          readOnly={readOnly}
        />
      </View>
      {!readOnly && bothSuccessful && battle.decision === null ? (
        <View style={styles.tieRow}>
          <Button
            variant="outline"
            size="sm"
            disabled={action !== null}
            loading={action === "tie"}
            onPress={chooseTie}
          >
            Tie
          </Button>
        </View>
      ) : null}
      {bothTerminal || battle.comparison.status !== "pending" ? (
        <ArenaComparison battle={battle} />
      ) : null}
    </View>
  );
});

export const ArenaBattleSummaryCard = memo(function ArenaBattleSummaryCard({
  serverId,
  battleId,
}: {
  serverId: string;
  battleId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const supported = useArenaSupported(serverId);
  const battle = useBattleById(serverId, battleId, client, supported);
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.card}>
      <Pressable
        onPress={toggleExpanded}
        style={cardHeaderStyle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
      >
        {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        <Swords size={17} />
        <Text numberOfLines={2} style={styles.cardLabel}>
          {summaryCardLabel(supported, battle)}
        </Text>
      </Pressable>
      {expanded && battle && supported ? (
        <View style={styles.expandedCard}>
          <ArenaBattleView serverId={serverId} battle={battle} readOnly />
        </View>
      ) : null}
    </View>
  );
});

export function getArenaBattleIdFromToolMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).arenaBattleId;
  return typeof value === "string" && value ? value : null;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  readOnlyRoot: {
    height: 520,
    backgroundColor: theme.colors.surface0,
  },
  inlineRoot: {
    height: 600,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  battleHeader: {
    minHeight: 48,
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  battleTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sides: {
    flex: 1,
    minHeight: 260,
    flexDirection: "row",
  },
  sidePane: {
    flex: 1,
    minWidth: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  sideHeader: {
    minHeight: 42,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  sideIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sideBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  sideBadgeText: {
    color: theme.colors.accentForeground,
    fontWeight: theme.fontWeight.bold,
  },
  sideTitle: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  statusError: {
    color: theme.colors.destructive,
  },
  thread: {
    flex: 1,
    overflow: "hidden",
  },
  chooseRow: {
    padding: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    alignItems: "stretch",
  },
  tieRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    alignItems: "center",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  retainedTranscript: {
    padding: theme.spacing[3],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  comparison: {
    maxHeight: 260,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  comparisonContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  diffRoot: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  diffFile: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  diffFileHeader: {
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  diffPath: {
    flex: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  diffStats: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  codeScroll: {
    maxHeight: 180,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  codeBlock: {
    minWidth: "100%",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  codeLine: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  codeAdd: {
    color: theme.colors.success,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  codeDelete: {
    color: theme.colors.destructive,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  codeHeader: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  codeMuted: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  summary: {
    gap: theme.spacing[2],
  },
  summaryLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  cardHeader: {
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  expandedCard: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  pressed: {
    opacity: 0.72,
  },
}));
