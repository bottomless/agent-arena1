import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import type { ArenaThinkingLevel } from "@getpaseo/protocol/arena";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { getArenaPreferences, useArenaStore } from "@/arena/store";
import { arenaUnavailableMessage } from "@/arena/capability";

const THINKING_OPTIONS: Array<{ value: ArenaThinkingLevel; label: string }> = [
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export const ArenaComposerControls = memo(function ArenaComposerControls({
  preferenceKey,
  supported,
  disabled = false,
}: {
  preferenceKey: string;
  supported: boolean;
  disabled?: boolean;
}) {
  const stored = useArenaStore((state) => state.preferences[preferenceKey]);
  const preferences = stored ?? getArenaPreferences(preferenceKey);
  const setBattleMode = useArenaStore((state) => state.setBattleMode);
  const setThinkingLevel = useArenaStore((state) => state.setThinkingLevel);
  const thinkingOptions = useMemo(
    () => THINKING_OPTIONS.map(({ value, label }) => ({ value, label, disabled })),
    [disabled],
  );
  const handleBattleModeChange = useCallback(
    (enabled: boolean) => setBattleMode(preferenceKey, enabled),
    [preferenceKey, setBattleMode],
  );
  const handleThinkingChange = useCallback(
    (level: ArenaThinkingLevel) => setThinkingLevel(preferenceKey, level),
    [preferenceKey, setThinkingLevel],
  );

  if (!supported) {
    return <Text style={styles.unavailable}>{arenaUnavailableMessage()}</Text>;
  }

  return (
    <View style={styles.row}>
      <View style={styles.toggleGroup}>
        <Switch
          value={preferences.battleMode}
          onValueChange={handleBattleModeChange}
          disabled={disabled}
          accessibilityLabel="Battle mode"
          testID="arena-battle-toggle"
        />
        <Text style={styles.label}>Battle</Text>
      </View>
      {!preferences.battleMode ? (
        <SegmentedControl
          options={thinkingOptions}
          value={preferences.thinkingLevel}
          onValueChange={handleThinkingChange}
          size="xs"
          testID="arena-thinking-level"
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  toggleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  unavailable: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
