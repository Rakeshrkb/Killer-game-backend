// redisUtils.ts
import { redis } from "./redisClient";
import { Player, GamePlayer, RoomSnapshot, RoomStatus } from "./types";
import { playerNameKey, playersSetKey, playerKey, roomKey, rematchVotesKey, gamePlayersSetKey, gamePlayerKey, gridKey, gameKey } from "./redisClient";


export async function setPlayerNameStore(socketId: string, name: string) {
  await redis.set(playerNameKey(socketId), name, "EX", 3600);
}

export async function getPlayerName(socketId: string): Promise<string | null> {
  return redis.get(playerNameKey(socketId));
}

export async function deletePlayerName(socketId: string) {
  await redis.del(playerNameKey(socketId));
}

export async function addPlayer(roomId: string, player: Player) {
  await redis.sadd(playersSetKey(roomId), player.socketId);
  await redis.hset(playerKey(roomId, player.socketId), {
    name: player.name,
    ready: String(player.ready),
    score: String(player.score),
    status: player.status,
    isHost: String(player.isHost),
  });
}

export async function removePlayerFromRoom(roomId: string, socketId: string) {
  await redis.srem(playersSetKey(roomId), socketId);
  await redis.del(playerKey(roomId, socketId));
}

// add to redisUtils.ts
export async function getRoom(roomId: string): Promise<RoomSnapshot | null> {
  const roomHash = await redis.hgetall(roomKey(roomId));
  if (!roomHash || !roomHash.hostId) return null;

  const socketIds = await redis.smembers(playersSetKey(roomId));
  const players: Player[] = [];

  for (const socketId of socketIds) {
    const p = await redis.hgetall(playerKey(roomId, socketId));
    if (!p.name) continue;
    players.push({
      socketId,
      name: p.name,
      ready: p.ready === "true",
      score: parseInt(p.score || "0", 10),
      status: p.status as any,
      isHost: p.isHost === "true",
    });
  }

  return {
    roomId,
    hostId: roomHash.hostId,
    status: roomHash.status as RoomStatus,
    players,
    rematchVotes: await redis.smembers(rematchVotesKey(roomId)),
    rematchDeadline: roomHash.rematchDeadline ? parseInt(roomHash.rematchDeadline, 10) : null,
  };
}

export async function getRoomStatus(roomId: string): Promise<string | null> {
  const status = await redis.hget(roomKey(roomId), "status");
  return status;
}

export async function playerExistsInRoom(roomId: string, socketId: string): Promise<boolean> {
  const exists = await redis.sismember(playersSetKey(roomId), socketId);
  return exists === 1;
}

export async function toggleReady(roomId: string, socketId: string): Promise<boolean> {
  const current = await redis.hget(playerKey(roomId, socketId), "ready");
  const newValue = current === "true" ? "false" : "true";
  await redis.hset(playerKey(roomId, socketId), "ready", newValue);
  return newValue === "true";
}


export async function removeRematchVote(roomId: string, socketId: string) {
  await redis.srem(rematchVotesKey(roomId), socketId);
}

export async function getPlayerCount(roomId: string): Promise<number> {
  return redis.scard(playersSetKey(roomId));
}

export async function getRematchVoteCount(roomId: string): Promise<number> {
  return redis.scard(rematchVotesKey(roomId));
}

export async function deleteRoomEntirely(roomId: string) {
  await redis.del(roomKey(roomId));
  await redis.del(playersSetKey(roomId));
  await redis.del(rematchVotesKey(roomId));
}

export async function assignNewHost(roomId: string): Promise<{ socketId: string; name: string } | null> {
  const newHostId = await redis.srandmember(playersSetKey(roomId));
  if (!newHostId) return null;

  await redis.hset(roomKey(roomId), "hostId", newHostId);
  await redis.hset(playerKey(roomId, newHostId), "isHost", "true");

  const name = (await redis.hget(playerKey(roomId, newHostId), "name")) || '';
  return { socketId: newHostId, name };
}


export async function getPlayersNotVoted(roomId: string): Promise<string[]> {
  return redis.sdiff(playersSetKey(roomId), rematchVotesKey(roomId));
}

export async function resetRoomForRematch(roomId: string) {
  await redis.hset(roomKey(roomId), { status: "IN_LOBBY", rematchDeadline: "" });
  await redis.del(rematchVotesKey(roomId));
}

export async function initGamePlayers(roomId: string, players: GamePlayer[]) {
  const pipeline = redis.pipeline();
  for (const p of players) {
    pipeline.sadd(gamePlayersSetKey(roomId), p.socketId);
    pipeline.hset(gamePlayerKey(roomId, p.socketId), {
      name: p.name,
      posRow: String(p.pos.row),
      posCol: String(p.pos.col),
      alive: "true",
      kills: "0",
      lastMoveAt: "0",
    });
  }
  await pipeline.exec();
}

export async function setGameGrid(roomId: string, grid: number[][]) {
  await redis.set(gridKey(roomId), JSON.stringify(grid));
}

export async function getPlayerMoveState(roomId: string, socketId: string) {
  const [row, col, alive, lastMoveAt] = await redis.hmget(
    gamePlayerKey(roomId, socketId), "posRow", "posCol", "alive", "lastMoveAt"
  );
  if (row === null) return null;
  return {
    pos: { row: parseInt(row, 10), col: parseInt(col!, 10) },
    alive: alive === "true",
    lastMoveAt: parseInt(lastMoveAt || "0", 10),
  };
}

export async function getKillerId(roomId: string): Promise<string | null> {
  return redis.hget(`game:${roomId}`, "killerId");
}

export async function getOtherAlivePositions(roomId: string, excludeSocketId: string) {
  const socketIds = await redis.smembers(gamePlayersSetKey(roomId));
  const others = socketIds.filter((id) => id !== excludeSocketId);
  if (others.length === 0) return [];

  const pipeline = redis.pipeline();
  others.forEach((id) => pipeline.hmget(gamePlayerKey(roomId, id), "posRow", "posCol", "alive"));
  const results = await pipeline.exec();

  return others
    .map((socketId, i) => {
      const [, res] = results![i];
      const [row, col, alive] = res as [string, string, string];
      return { socketId, row: parseInt(row, 10), col: parseInt(col, 10), alive: alive === "true" };
    })
    .filter((p) => p.alive);
}

export async function updatePlayerPosition(roomId: string, socketId: string, row: number, col: number, now: number) {
  await redis.hset(gamePlayerKey(roomId, socketId), { posRow: String(row), posCol: String(col), lastMoveAt: String(now) });
}

export async function markPlayerDead(roomId: string, socketId: string) {
  await redis.hset(gamePlayerKey(roomId, socketId), "alive", "false");
}

export async function incrementKillerKills(roomId: string, killerId: string): Promise<number> {
  return redis.hincrby(gamePlayerKey(roomId, killerId), "kills", 1);
}

export async function revivePlayer(roomId: string, socketId: string, row: number, col: number) {
  await redis.hset(gamePlayerKey(roomId, socketId), { posRow: String(row), posCol: String(col), alive: "true" });
}

export async function addRematchVoteAndCheckFirst(roomId: string, socketId: string): Promise<{ voteCount: number; isFirstVote: boolean }> {
  const added = await redis.sadd(rematchVotesKey(roomId), socketId);
  const voteCount = await redis.scard(rematchVotesKey(roomId));
  return { voteCount, isFirstVote: added === 1 && voteCount === 1 };
}

export async function setNewHostForRematch(roomId: string, newHostId: string) {
  await redis.hset(roomKey(roomId), "hostId", newHostId);

  const socketIds = await redis.smembers(playersSetKey(roomId));
  const pipeline = redis.pipeline();
  socketIds.forEach((id) => {
    pipeline.hset(playerKey(roomId, id), "isHost", id === newHostId ? "true" : "false");
  });
  await pipeline.exec();
}

export async function getGameStandings(roomId: string) {
  const socketIds = await redis.smembers(gamePlayersSetKey(roomId));
  const pipeline = redis.pipeline();
  socketIds.forEach((id) => pipeline.hmget(gamePlayerKey(roomId, id), "name", "kills"));
  const results = await pipeline.exec();

  return socketIds
    .map((socketId, i) => {
      const [, res] = results![i];
      const [name, kills] = res as [string, string];
      return { socketId, name, kills: parseInt(kills || "0", 10) };
    })
    .sort((a, b) => b.kills - a.kills);
}

export async function setRoomEnded(roomId: string, rematchDeadline: number) {
  await redis.hset(roomKey(roomId), { status: "ENDED", rematchDeadline: String(rematchDeadline) });
}

export async function deleteGame(roomId: string) {
  const socketIds = await redis.smembers(gamePlayersSetKey(roomId));
  const pipeline = redis.pipeline();
  socketIds.forEach((id) => pipeline.del(gamePlayerKey(roomId, id)));
  pipeline.del(gamePlayersSetKey(roomId));
  pipeline.del(gridKey(roomId));
  pipeline.del(gameKey(roomId));
  await pipeline.exec();
}

// add to redisUtils.ts
export function toPublicRoomState(room: RoomSnapshot) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    players: room.players,
  };
}