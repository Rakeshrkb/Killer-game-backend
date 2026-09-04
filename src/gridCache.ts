import { redis } from './redisClient';
import { gridKey } from './redisClient';
// gridCache.ts — a small local cache, NOT a Redis replacement, just an optimization layer in front of it
const localGridCache = new Map<string, number[][]>();

export async function getGameGrid(roomId: string): Promise<number[][] | null> {
    if (localGridCache.has(roomId)) {
        return localGridCache.get(roomId)!;
    }
    const raw = await redis.get(gridKey(roomId));
    if (!raw) return null;
    const grid = JSON.parse(raw);
    localGridCache.set(roomId, grid);
    return grid;
}

export function clearGridCache(roomId: string) {
    localGridCache.delete(roomId);
}