import { useCallback, useEffect, useMemo, useRef } from "react";
import { Keyboard, ScrollView, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ReanimatedAnimated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { AgentStreamView } from "@/agent-stream/view";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "@/composer/draft/create-flow";
import { resolveTurnPresentation, TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { usePanelStore } from "@/stores/panel-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { Agent } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import { shouldAllowEmptyDraftText } from "@/composer/draft/workspace-tab-core";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { ArenaBattle } from "@getpaseo/protocol/arena";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import { ArenaComposerControls } from "@/arena/controls";
import { arenaChatKey, getArenaPreferences, useArenaStore } from "@/arena/store";
import { arenaUnavailableMessage, useArenaSupported } from "@/arena/capability";
import { ArenaBattleView, useArenaBattleForWorkspace } from "@/arena/battle-view";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { UserMessage } from "@/components/message";

const EMPTY_PENDING_PERMISSIONS = new Map();
const EMPTY_ONLINE_SERVER_IDS: string[] = [];
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

type DraftArenaCreateResult =
  | { kind: "single"; snapshot: AgentSnapshotPayload }
  | { kind: "battle"; battle: ArenaBattle };

async function submitDraftCreateRequest(input: {
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: unknown;
  client: DaemonClient | null;
  serverId: string;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  preferenceKey: string;
  battleMode: boolean;
  thinkingLevel: "low" | "high" | "max";
  arenaSupported: boolean;
  hostDisconnectedMessage: string;
}): Promise<{ agentId: string | null; result: DraftArenaCreateResult }> {
  const { text, images, attachments, client, workspaceDirectory, workspaceId } = input;

  invariant(workspaceDirectory, "Workspace directory is required");
  invariant(workspaceId, "Workspace id is required");
  if (!client) {
    throw new Error(input.hostDisconnectedMessage);
  }
  if (!input.arenaSupported) throw new Error(arenaUnavailableMessage());

  if ((images?.length ?? 0) > 0 || (Array.isArray(attachments) && attachments.length > 0)) {
    throw new Error("Arena turns do not support attachments yet.");
  }

  if (input.battleMode) {
    const battle = await client.startArenaBattle({ workspaceId, prompt: text });
    useArenaStore.getState().upsertBattle(input.serverId, battle);
    const sideIds = [battle.sides.A.agentId, battle.sides.B.agentId];
    useArenaStore.getState().inheritPreferences(
      input.preferenceKey,
      sideIds
        .filter((id): id is string => Boolean(id))
        .map((id) => arenaChatKey(input.serverId, id)),
    );
    return { agentId: null, result: { kind: "battle", battle } };
  }

  const single = await client.runArenaSingleTurn({
    workspaceId,
    prompt: text,
    thinkingLevel: input.thinkingLevel,
  });
  useArenaStore
    .getState()
    .inheritPreferences(input.preferenceKey, [arenaChatKey(input.serverId, single.agentId)]);
  const fetched = await client.fetchAgent({ agentId: single.agentId });
  if (!fetched) throw new Error("Arena agent was not found after creation.");

  return {
    agentId: single.agentId,
    result: { kind: "single", snapshot: fetched.agent },
  };
}

function buildDraftAgentSnapshot(input: {
  attempt: { timestamp: Date };
  serverId: string;
  tabId: string;
  workspaceDirectory: string | null;
}): Agent {
  const { attempt, serverId, tabId, workspaceDirectory } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  const now = attempt.timestamp;
  return {
    serverId,
    id: tabId,
    provider: "opencode",
    status: "running",
    activeTurn: null,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: DRAFT_CAPABILITIES,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider: "opencode", sessionId: null, model: null, modeId: null },
    title: "Agent",
    cwd: workspaceDirectory,
    model: null,
    features: undefined,
    thinkingOptionId: "high",
    parentAgentId: null,
    labels: {},
  };
}

function buildDraftInitialValues(input: {
  workingDir: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (!input.workingDir) {
    return undefined;
  }
  if (!input.initialSetup) {
    return { workingDir: input.workingDir };
  }
  return {
    workingDir: input.workingDir,
    provider: input.initialSetup.provider,
    modeId: input.initialSetup.modeId,
    model: input.initialSetup.model,
    thinkingOptionId: input.initialSetup.thinkingOptionId,
  };
}

function resolveDraftWorkingDirectory(input: {
  workspaceDirectory: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): string | null {
  if (input.initialSetup) {
    return input.initialSetup.cwd;
  }
  return input.workspaceDirectory;
}

function resolveOnlineServerIds(input: { isConnected: boolean; serverId: string }): string[] {
  if (!input.isConnected) {
    return EMPTY_ONLINE_SERVER_IDS;
  }
  return [input.serverId];
}

interface WorkspaceDraftAgentTabProps {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  initialSetup?: WorkspaceDraftTabSetup;
  isPaneFocused: boolean;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
  onOpenImportSheet?: () => void;
}

export function WorkspaceDraftAgentTab({
  serverId,
  workspaceId,
  tabId,
  draftId,
  initialSetup = undefined,
  isPaneFocused,
  onCreated,
  onOpenWorkspaceFile,
}: WorkspaceDraftAgentTabProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
    id: w.id,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const draftSetup = initialSetup ?? null;
  const draftWorkingDirectory = resolveDraftWorkingDirectory({
    workspaceDirectory,
    initialSetup: draftSetup,
  });
  const draftInitialValues = buildDraftInitialValues({
    workingDir: draftWorkingDirectory,
    initialSetup: draftSetup,
  });
  const onlineServerIds = resolveOnlineServerIds({ isConnected, serverId });
  const draftStoreKey = useMemo(
    () =>
      buildDraftStoreKey({
        serverId,
        agentId: tabId,
        draftId,
      }),
    [draftId, serverId, tabId],
  );
  const draftInput = useAgentInputDraft({
    draftKey: draftStoreKey,
    composer: {
      initialServerId: serverId,
      initialValues: draftInitialValues,
      initialFeatureValues: draftSetup?.featureValues,
      isVisible: true,
      onlineServerIds,
      lockedWorkingDir: draftWorkingDirectory ?? undefined,
    },
  });
  const composerState = draftInput.composerState;
  if (!composerState) {
    throw new Error("Workspace draft composer state is required");
  }

  const arenaPreferenceKey = arenaChatKey(serverId, tabId);
  const arenaSupported = useArenaSupported(serverId);
  const activeBattle = useArenaBattleForWorkspace(serverId, workspaceId);

  const clearDraftInput = draftInput.clear;
  const setDraftText = draftInput.setText;
  const setDraftAttachments = draftInput.setAttachments;
  const pendingAutoSubmit = useWorkspaceDraftSubmissionStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.workspaceId === workspaceId ? pending : null;
  });
  const pendingCreateAttempt = useCreateFlowStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.lifecycle === "active" ? pending : null;
  });
  const consumePendingAutoSubmit = useWorkspaceDraftSubmissionStore(
    (state) => state.consumePending,
  );
  const initialCreateAttempt = useMemo<DraftCreateAttempt | null>(() => {
    if (!pendingAutoSubmit || !pendingCreateAttempt) {
      return null;
    }
    if (pendingAutoSubmit.clientMessageId !== pendingCreateAttempt.clientMessageId) {
      return null;
    }
    return {
      clientMessageId: pendingCreateAttempt.clientMessageId,
      text: pendingCreateAttempt.text,
      timestamp: new Date(pendingCreateAttempt.timestamp),
      ...(pendingCreateAttempt.images && pendingCreateAttempt.images.length > 0
        ? { images: pendingCreateAttempt.images }
        : {}),
      ...(pendingCreateAttempt.attachments && pendingCreateAttempt.attachments.length > 0
        ? { attachments: pendingCreateAttempt.attachments }
        : {}),
    };
  }, [pendingAutoSubmit, pendingCreateAttempt]);
  const allowsEmptyAutoSubmit = pendingAutoSubmit?.allowEmptyText === true;
  const isCompactFormFactor = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd: composerState.workingDir,
    workspaceId,
  });
  const draftAttachmentScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const attachmentScopeKeys = useMemo(
    () => [draftAttachmentScopeKey, workspaceAttachmentScopeKey].filter(Boolean),
    [draftAttachmentScopeKey, workspaceAttachmentScopeKey],
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );
  const openFileExplorerForCheckout = usePanelStore((state) => state.openFileExplorerForCheckout);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      const checkout = {
        serverId,
        cwd: attachment.attachment.cwd,
        isGit: true,
      };
      openFileExplorerForCheckout({
        checkout,
        isCompact: isCompactFormFactor,
      });
      setExplorerTabForCheckout({
        ...checkout,
        tab: "changes",
      });
    },
    [isCompactFormFactor, openFileExplorerForCheckout, serverId, setExplorerTabForCheckout],
  );

  const {
    formErrorMessage,
    isSubmitting,
    submittedStreamItems,
    pendingMessageSubmissions,
    draftAgent,
    handleCreateFromInput,
    continueCreateFromAttempt,
  } = useDraftAgentCreateFlow<Agent, DraftArenaCreateResult>({
    draftId,
    getPendingServerId: () => serverId,
    initialAttempt: initialCreateAttempt,
    allowEmptyText: allowsEmptyAutoSubmit,
    validateBeforeSubmit: ({ text, attachments }) => {
      const allowsEmptyDraftText = shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit,
        attachments,
      });
      if (!client) return t("workspace.terminal.hostDisconnected");
      if (!arenaSupported) return arenaUnavailableMessage();
      if (!draftWorkingDirectory) return "Choose a workspace before starting a chat.";
      if (!text.trim() && !allowsEmptyDraftText) return "Enter a prompt to start the chat.";
      if (attachments.length > 0) return "Arena turns do not support attachments yet.";
      return null;
    },
    onBeforeSubmit: async () => {
      if (isWeb) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: (attempt) =>
      buildDraftAgentSnapshot({
        attempt,
        serverId,
        tabId,
        workspaceDirectory: draftWorkingDirectory,
      }),
    createRequest: async ({ text, images, attachments }) =>
      submitDraftCreateRequest({
        text,
        images,
        attachments,
        client,
        serverId,
        workspaceDirectory: draftWorkingDirectory,
        workspaceId: workspaceFields?.id ?? null,
        preferenceKey: arenaPreferenceKey,
        battleMode: getArenaPreferences(arenaPreferenceKey).battleMode,
        thinkingLevel: getArenaPreferences(arenaPreferenceKey).thinkingLevel,
        arenaSupported,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    onCreateSuccess: ({ result }) => {
      clearDraftInput("sent");
      clearWorkspaceAttachments({ scopeKey: draftAttachmentScopeKey });
      useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
      if (result.kind === "single") onCreated(result.snapshot);
    },
  });
  const turnPresentation = useMemo(
    () => resolveTurnPresentation(TURN_LIVENESS_IDLE, pendingMessageSubmissions.length > 0),
    [pendingMessageSubmissions],
  );
  const isReadyForPendingAutoSubmit = Boolean(
    pendingAutoSubmit && draftInput.isHydrated && draftWorkingDirectory && client && arenaSupported,
  );
  const autoSubmitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReadyForPendingAutoSubmit) {
      return;
    }
    const submitKey = `${serverId}:${workspaceId}:${draftId}`;
    if (autoSubmitKeyRef.current === submitKey) {
      return;
    }
    const submission = consumePendingAutoSubmit({ serverId, workspaceId, draftId });
    if (!submission) {
      return;
    }
    autoSubmitKeyRef.current = submitKey;
    setDraftText("");
    setDraftAttachments([]);
    const preparedAttempt =
      initialCreateAttempt?.clientMessageId === submission.clientMessageId
        ? initialCreateAttempt
        : null;
    const createPromise = preparedAttempt
      ? continueCreateFromAttempt({
          attempt: preparedAttempt,
          cwd: submission.cwd,
        })
      : handleCreateFromInput({
          text: submission.text,
          attachments: submission.attachments,
          cwd: submission.cwd,
        });
    void createPromise.catch(() => {
      setDraftText(submission.text);
      setDraftAttachments(composerWorkspaceAttachment.userAttachmentsOnly(submission.attachments));
      autoSubmitKeyRef.current = null;
    });
  }, [
    continueCreateFromAttempt,
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    initialCreateAttempt,
    isReadyForPendingAutoSubmit,
    serverId,
    setDraftAttachments,
    setDraftText,
    workspaceId,
  ]);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

  const { style: composerKeyboardStyle } = useKeyboardShiftStyle({
    mode: "translate",
  });

  const inputAreaWrapperStyle = useMemo(
    () => [
      animatedStaticStyles.inputAreaWrapper,
      { paddingBottom: insets.bottom },
      composerKeyboardStyle,
    ],
    [insets.bottom, composerKeyboardStyle],
  );

  const arenaToolbarControls = useMemo(
    () => (
      <ArenaComposerControls
        preferenceKey={arenaPreferenceKey}
        supported={arenaSupported}
        disabled={isSubmitting}
      />
    ),
    [arenaPreferenceKey, arenaSupported, isSubmitting],
  );
  const handleBattleDecided = useCallback(
    (battle: ArenaBattle) => {
      const winnerId = battle.winningSide ? battle.sides[battle.winningSide].agentId : null;
      if (winnerId) navigateToAgent({ serverId, agentId: winnerId });
    },
    [serverId],
  );
  if (
    activeBattle &&
    activeBattle.decision === null &&
    activeBattle.status !== "stopped" &&
    activeBattle.status !== "error"
  ) {
    return (
      <FileDropZone style={styles.container}>
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.inlineBattleContent}>
          <UserMessage
            message={activeBattle.prompt}
            timestamp={Date.parse(activeBattle.createdAt)}
            disableOuterSpacing
          />
          <ArenaBattleView
            serverId={serverId}
            battle={activeBattle}
            onDecided={handleBattleDecided}
            inline
          />
        </ScrollView>
      </FileDropZone>
    );
  }
  return (
    <FileDropZone style={styles.container}>
      <View style={styles.contentContainer}>
        {isSubmitting && draftAgent ? (
          <View style={styles.streamContainer}>
            <AgentStreamView
              agentId={tabId}
              serverId={serverId}
              context={draftAgent}
              streamItems={submittedStreamItems}
              pendingMessageSubmissions={pendingMessageSubmissions}
              turnPresentation={turnPresentation}
              pendingPermissions={EMPTY_PENDING_PERMISSIONS}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          </View>
        ) : (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.configScrollContent}>
            <View style={styles.configSection}>
              {formErrorMessage ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>{formErrorMessage}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </View>

      <ReanimatedAnimated.View style={inputAreaWrapperStyle} onLayout={onInputAreaLayout}>
        <Composer
          agentId={tabId}
          serverId={serverId}
          workspaceId={workspaceId}
          externalKeyboardShift
          isPaneFocused={isPaneFocused}
          onSubmitMessage={handleCreateFromInput}
          isSubmitLoading={isSubmitting}
          blurOnSubmit={true}
          value={draftInput.text}
          onChangeText={draftInput.setText}
          attachments={draftInput.attachments}
          attachmentScopeKeys={attachmentScopeKeys}
          onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
          onChangeAttachments={draftInput.setAttachments}
          cwd={composerState.workingDir}
          clearDraft={draftInput.clear}
          autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
          autoFocusKey={String(draftInput.attachmentFocusRequestId)}
          onFocusInput={handleFocusInputCallback}
          commandDraftConfig={composerState.commandDraftConfig}
          toolbarControls={arenaToolbarControls}
          allowAttachments={false}
          isCompactLayout={isCompactComposerLayout}
        />
      </ReanimatedAnimated.View>
    </FileDropZone>
  );
}

const animatedStaticStyles = RNStyleSheet.create({
  inputAreaWrapper: {
    width: "100%",
  },
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
  },
  streamContainer: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  configScrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  inlineBattleContent: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[4],
  },
  configSection: {
    gap: theme.spacing[3],
  },
  errorContainer: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
