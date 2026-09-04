// rematchScheduler.ts
import { redis } from "./redisClient";
import { Server } from "socket.io";

const PENDING_REMATCH_KEY = "pending_rematch_resolutions";
const SWEEP_INTERVAL_MS = 250;

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

async function tryClaim(roomId: string, deadline: number): Promise<boolean> {
  if (!claimScriptSha) await loadClaimScript();
  const claimKey = `rematch_claim:${roomId}:${deadline}`;
  const result = await redis.evalsha(claimScriptSha as string, 1, claimKey, "5000");
  return result === 1;
}

export async function scheduleRematchResolution(roomId: string, delayMs: number) {
  const resolveAt = Date.now() + delayMs;
  await redis.zadd(PENDING_REMATCH_KEY, resolveAt, roomId);
  return resolveAt;
}

export async function cancelRematchResolution(roomId: string) {
  await redis.zrem(PENDING_REMATCH_KEY, roomId);
}

export function startRematchSweep(
  io: Server,
  resolveFn: (roomId: string, io: Server) => Promise<void>
) {
  setInterval(async () => {
    const now = Date.now();
    const dueRoomIds = await redis.zrangebyscore(PENDING_REMATCH_KEY, 0, now);

    for (const roomId of dueRoomIds) {
      const deadline = await redis.zscore(PENDING_REMATCH_KEY, roomId);
      if (!deadline) continue;

      const won = await tryClaim(roomId, Number(deadline));
      if (!won) continue;

      await redis.zrem(PENDING_REMATCH_KEY, roomId);
      await resolveFn(roomId, io);
    }
  }, SWEEP_INTERVAL_MS);
}