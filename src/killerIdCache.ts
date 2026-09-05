// killerIdCache.ts
const localKillerCache = new Map<string, string>();

export function getCachedKillerId(roomId: string): string | undefined {
  return localKillerCache.get(roomId);
}
export function setCachedKillerId(roomId: string, killerId: string) {
  localKillerCache.set(roomId, killerId);
}
export function clearKillerIdCache(roomId: string) {
  localKillerCache.delete(roomId);
}