import { redis } from "./redisClient";
import { Server } from "socket.io";
import { getWalkableTiles } from "./maze";
import { getKillerId, getPlayerMoveState, revivePlayer } from "./redisUtils";

const PENDING_RESPAWNS_KEY = "pending_respawns";
const SWEEP_INTERVAL_MS = 250;
const RESPAWN_DELAY_MS = 3000;

const CLAIM_SCRIPT = `
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
  end
  redis.call("SET", KEYS[1], "1", "PX", ARGV[1])
  return 1
`;

let claimScriptSha: string | null = null;

async function loadClaimScript() {
  claimScriptSha = (await redis.script("LOAD", CLAIM_SCRIPT)) as string;
}

async function tryClaim(memberId: string, deadline: number): Promise<boolean> {
  if (!claimScriptSha) await loadClaimScript();
  const claimKey = `respawn_claim:${memberId}:${deadline}`;
  const result = await redis.evalsha(claimScriptSha as string, 1, claimKey, "5000");
  return result === 1;
}

// member format: "roomId::socketId" — lets multiple pending respawns coexist per room
const memberId = (roomId: string, socketId: string) => `${roomId}::${socketId}`;

export async function scheduleRespawn(roomId: string, socketId: string) {
  const respawnAt = Date.now() + RESPAWN_DELAY_MS;
  await redis.zadd(PENDING_RESPAWNS_KEY, respawnAt, memberId(roomId, socketId));
}

export async function cancelRespawn(roomId: string, socketId: string) {
  await redis.zrem(PENDING_RESPAWNS_KEY, memberId(roomId, socketId));
}

async function executeRespawn(roomId: string, socketId: string, io: Server) {
  const killerId = await getKillerId(roomId);
  if (!killerId) return;

  const killerState = await getPlayerMoveState(roomId, killerId);
  if (!killerState) return; // killer disconnected — skip, matches original's early-return

  const playerState = await getPlayerMoveState(roomId, socketId);
  if (!playerState) return; // victim disconnected — matches original's early-return

  const walkableTiles = getWalkableTiles();
  const farTiles = walkableTiles.filter((tile) => {
    const dist = Math.abs(tile.row - killerState.pos.row) + Math.abs(tile.col - killerState.pos.col);
    return dist > 4;
  });

  const pool = farTiles.length > 0 ? farTiles : walkableTiles;
  const spawnTile = pool[Math.floor(Math.random() * pool.length)];

  await revivePlayer(roomId, socketId, spawnTile.row, spawnTile.col);

  io.to(roomId).emit("message", {
    action: "PLAYER_RESPAWNED",
    result: "success",
    payload: { socketId, pos: spawnTile },
  });
}

export function startRespawnSweep(io: Server) {
  setInterval(async () => {
    const now = Date.now();
    const dueMembers = await redis.zrangebyscore(PENDING_RESPAWNS_KEY, 0, now);

    for (const member of dueMembers) {
      const deadline = await redis.zscore(PENDING_RESPAWNS_KEY, member);
      if (!deadline) continue;

      const won = await tryClaim(member, Number(deadline));
      if (!won) continue;

      await redis.zrem(PENDING_RESPAWNS_KEY, member);

      const [roomId, socketId] = member.split("::");
      await executeRespawn(roomId, socketId, io);
    }
  }, SWEEP_INTERVAL_MS);
}