// redisClient.ts
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from "ioredis";
export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
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