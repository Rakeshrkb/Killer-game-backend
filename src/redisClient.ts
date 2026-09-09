// redisClient.ts
import Redis from "ioredis";
// export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
const sentinelPort = Number(
    process.env.REDIS_SENTINEL_PORT || 26379
);

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

const sentinels = [
    requireEnv("REDIS_SENTINEL_1"),
    requireEnv("REDIS_SENTINEL_2"),
    requireEnv("REDIS_SENTINEL_3"),
].map((host) => ({ host, port: sentinelPort }));

export const redis = new Redis({
    sentinels,
    name: process.env.REDIS_MASTER_NAME || "mymaster",
    password: process.env.REDIS_PASSWORD,
    sentinelRetryStrategy: (times) => Math.min(times * 100, 2000),
    retryStrategy: (times) => Math.min(times * 100, 2000),
});

export const subClient = redis.duplicate();



/* ------------------REDIS DATA STRUCTURES-----------------------------*/
export const playerNameKey = (socketId: string) => `playerName:${socketId}`;
export const roomKey = (roomId: string) => `room:${roomId}`;
export const playersSetKey = (roomId: string) => `room:${roomId}:players`;
export const playerKey = (roomId: string, socketId: string) => `room:${roomId}:player:${socketId}`;
export const rematchVotesKey = (roomId: string) => `room:${roomId}:rematchVotes`;
export const gamePlayersSetKey = (roomId: string) => `game:${roomId}:players`;
export const gamePlayerKey = (roomId: string, socketId: string) => `game:${roomId}:player:${socketId}`;
export const gridKey = (roomId: string) => `game:${roomId}:grid`;
export const gameKey = (roomId: string) => `game:${roomId}`;