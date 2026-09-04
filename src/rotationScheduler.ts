// rotationScheduler.ts
import { redis } from "./redisClient";
import { Server } from "socket.io";
import { endGame } from "./gameRoomInRedis";
const PENDING_ROTATIONS_KEY = "pending_rotations";
const SWEEP_INTERVAL_MS = 250;
export const ROTATION_DURATION_MS = 20_000; // however long a killer holds the role

// Atomically claim a specific (room, deadline) pair. Returns 1 if this
// instance won the claim, 0 if another instance already grabbed it.
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
  const claimKey = `rotation_claim:${roomId}:${deadline}`;
  const result = await redis.evalsha(claimScriptSha as string, 1, claimKey, "5000");
  return result === 1;
}


export async function scheduleNextRotation(roomId: string, delayMs: number) {
  const nextRotationAt = Date.now() + delayMs;
  await redis.hset(`game:${roomId}`, "nextRotationAt", nextRotationAt);
  await redis.zadd(PENDING_ROTATIONS_KEY, nextRotationAt, roomId);
  return nextRotationAt;
}

export async function cancelRotation(roomId: string) {
  await redis.zrem(PENDING_ROTATIONS_KEY, roomId);
}

async function executeRotation(roomId: string, io: Server) {
    const gameKey = `game:${roomId}`;

    const [
        killerOrderRaw,
        killerTurnIndexRaw,
        statusRaw,
        previousKillerId,
    ] = await redis.hmget(
        gameKey,
        "killerOrder",
        "killerTurnIndex",
        "status",
        "killerId"
    );

    if (statusRaw !== "ACTIVE") {
        await redis.zrem(PENDING_ROTATIONS_KEY, roomId);
        return;
    }

    const killerOrder: string[] = JSON.parse(killerOrderRaw || "[]");

    if (killerOrder.length === 0) {
        await redis.zrem(PENDING_ROTATIONS_KEY, roomId);
        return;
    }

    const currentIndex = parseInt(killerTurnIndexRaw || "0", 10);

    // Current killer was the LAST player in the rotation.
    // Therefore everyone has had one killer turn.
    if (currentIndex === killerOrder.length - 1) {
        await redis.zrem(PENDING_ROTATIONS_KEY, roomId);

        await endGame(roomId, io);

        return;
    }

    // Move to next killer
    const nextIndex = currentIndex + 1;
    const newKillerId = killerOrder[nextIndex];

    await redis.hset(
        gameKey,
        "killerTurnIndex",
        nextIndex,
        "killerId",
        newKillerId
    );

    await scheduleNextRotation(roomId, ROTATION_DURATION_MS);

    if (previousKillerId) {
        io.to(previousKillerId).emit("message", {
            action: "YOU_ARE_NOT_KILLER",
            result: "success",
        });
    }

    io.to(newKillerId).emit("message", {
        action: "YOU_ARE_KILLER",
        result: "success",
    });
}

export function startRotationSweep(io: Server) {
  setInterval(async () => {
    const now = Date.now();
    const dueRoomIds = await redis.zrangebyscore(PENDING_ROTATIONS_KEY, 0, now);

    for (const roomId of dueRoomIds) {
      const deadline = await redis.zscore(PENDING_ROTATIONS_KEY, roomId);
      if (!deadline) continue;

      const won = await tryClaim(roomId, Number(deadline));
      if (!won) continue; // another instance's sweep already grabbed this tick

      await redis.zrem(PENDING_ROTATIONS_KEY, roomId); // remove BEFORE executing
      await executeRotation(roomId, io);
    }
  }, SWEEP_INTERVAL_MS);
}