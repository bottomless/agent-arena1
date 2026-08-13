import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ArenaBattle, ArenaThinkingLevel } from "@getpaseo/protocol/arena";

export interface ArenaChatPreferences {
  battleMode: boolean;
  thinkingLevel: ArenaThinkingLevel;
}

interface ArenaState {
  battles: Record<string, ArenaBattle>;
  preferences: Record<string, ArenaChatPreferences>;
  upsertBattle: (serverId: string, battle: ArenaBattle) => void;
  setBattleMode: (key: string, enabled: boolean) => void;
  setThinkingLevel: (key: string, level: ArenaThinkingLevel) => void;
  inheritPreferences: (sourceKey: string, targetKeys: string[]) => void;
}

const DEFAULT_PREFERENCES: ArenaChatPreferences = {
  battleMode: true,
  thinkingLevel: "high",
};

export function arenaBattleKey(serverId: string, battleId: string): string {
  return `${serverId}:${battleId}`;
}

export function arenaChatKey(serverId: string, chatId: string): string {
  return `${serverId}:${chatId}`;
}

export const useArenaStore = create<ArenaState>()(
  persist(
    (set) => ({
      battles: {},
      preferences: {},
      upsertBattle: (serverId, battle) =>
        set((state) => ({
          battles: {
            ...state.battles,
            [arenaBattleKey(serverId, battle.id)]: battle,
          },
        })),
      setBattleMode: (key, enabled) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [key]: {
              ...(state.preferences[key] ?? DEFAULT_PREFERENCES),
              battleMode: enabled,
            },
          },
        })),
      setThinkingLevel: (key, level) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [key]: {
              ...(state.preferences[key] ?? DEFAULT_PREFERENCES),
              thinkingLevel: level,
            },
          },
        })),
      inheritPreferences: (sourceKey, targetKeys) =>
        set((state) => {
          const preferences = state.preferences[sourceKey] ?? DEFAULT_PREFERENCES;
          const next = { ...state.preferences };
          for (const targetKey of targetKeys) next[targetKey] = preferences;
          return { preferences: next };
        }),
    }),
    {
      name: "@paseo:arena-preferences-v1",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (persisted, current) => ({
        ...current,
        preferences:
          persisted && typeof persisted === "object" && "preferences" in persisted
            ? ((persisted as { preferences?: ArenaState["preferences"] }).preferences ?? {})
            : {},
      }),
    },
  ),
);

export function getArenaPreferences(key: string): ArenaChatPreferences {
  return useArenaStore.getState().preferences[key] ?? DEFAULT_PREFERENCES;
}

export function findArenaBattleForAgent(
  battles: Record<string, ArenaBattle>,
  serverId: string,
  agentId: string,
): ArenaBattle | null {
  const prefix = `${serverId}:`;
  let selected: ArenaBattle | null = null;
  for (const [key, battle] of Object.entries(battles)) {
    if (!key.startsWith(prefix)) continue;
    const matches =
      battle.sourceAgentId === agentId ||
      battle.sides.A.agentId === agentId ||
      battle.sides.B.agentId === agentId;
    if (!matches) continue;
    if (!selected) {
      selected = battle;
      continue;
    }
    const battleIsOpen = battle.decision === null && battle.status !== "error";
    const selectedIsOpen = selected.decision === null && selected.status !== "error";
    if (battleIsOpen !== selectedIsOpen) {
      if (battleIsOpen) selected = battle;
      continue;
    }
    if (battle.createdAt > selected.createdAt) selected = battle;
  }
  return selected;
}

export function findArenaBattleForWorkspace(
  battles: Record<string, ArenaBattle>,
  serverId: string,
  workspaceId: string,
): ArenaBattle | null {
  const prefix = `${serverId}:`;
  let selected: ArenaBattle | null = null;
  for (const [key, battle] of Object.entries(battles)) {
    if (!key.startsWith(prefix) || battle.sourceWorkspaceId !== workspaceId) continue;
    if (!selected) {
      selected = battle;
      continue;
    }
    const battleIsOpen = battle.decision === null && battle.status !== "error";
    const selectedIsOpen = selected.decision === null && selected.status !== "error";
    if (battleIsOpen !== selectedIsOpen) {
      if (battleIsOpen) selected = battle;
      continue;
    }
    if (battle.createdAt > selected.createdAt) selected = battle;
  }
  return selected;
}

export function inheritArenaPreferences(
  serverId: string,
  sourceChatId: string,
  targetChatIds: Array<string | null | undefined>,
): void {
  useArenaStore.getState().inheritPreferences(
    arenaChatKey(serverId, sourceChatId),
    targetChatIds.filter((id): id is string => Boolean(id)).map((id) => arenaChatKey(serverId, id)),
  );
}
