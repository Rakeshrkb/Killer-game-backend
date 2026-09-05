// killerIdCache.ts
import { redis } from "./redisClient";
const localKillerCache = new Map<string, string>();
const KILLER_UPDATE_CHANNEL = "killer_updates";
const killerCacheSubscriber = redis.duplicate();


killerCacheSubscriber.subscribe(KILLER_UPDATE_CHANNEL, (err) => {
    if (err) console.error("Failed to subscribe to killer updates:", err);
});

killerCacheSubscriber.on("message", (channel, message) => {
    if (channel !== KILLER_UPDATE_CHANNEL) return;
    const { roomId, killerId } = JSON.parse(message);
    localKillerCache.set(roomId, killerId);
});

export function getCachedKillerId(roomId: string): string | undefined {
    return localKillerCache.get(roomId);
}
export async function setCachedKillerId(roomId: string, killerId: string): Promise<void> {
    localKillerCache.set(roomId, killerId); // update locally immediately, don't wait on the round-trip
    await redis.publish(KILLER_UPDATE_CHANNEL, JSON.stringify({ roomId, killerId }));
}
export function clearKillerIdCache(roomId: string) {
    localKillerCache.delete(roomId);
}