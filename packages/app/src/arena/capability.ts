import { useHostFeature } from "@/runtime/host-features";
import { isWeb } from "@/constants/platform";

export const ARENA_HOST_UPDATE_MESSAGE =
  "Arena requires a newer Paseo host. Update the host and reconnect.";
export const ARENA_PLATFORM_MESSAGE = "Arena is currently available in the browser and Electron.";

export function arenaUnavailableMessage(): string {
  return isWeb ? ARENA_HOST_UPDATE_MESSAGE : ARENA_PLATFORM_MESSAGE;
}

export function useArenaSupported(serverId: string): boolean {
  const supportedByHost = useHostFeature(serverId, "arenaBattles");
  return isWeb && supportedByHost;
}
