import { rooms, roomToPublicState } from "./gameRoom";
import { Server } from 'socket.io';
import { gameStates, endGame } from "./gameRoom";
import { GameState, roomDetails } from "./types";
import { getWalkableTiles } from "./maze";
import { GridPos } from "./maze";
import { MAZE_GRID } from "./maze";
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { emit } from "cluster";
const COUNT_FILE = './data/visitor-count.json';

export function generateRoomId(): string {
  let id: string;
  do {
    id = Math.floor(100000 + Math.random() * 900000).toString(); // always 6 digits, no leading zero
  } while (rooms.has(id));
  return id;
}

export function rotateKiller(roomId: string, io: Server): void {
  const gameState = gameStates.get(roomId);
  if (!gameState) return;
  const previousKillerId = gameState.killerId;

  // Advance the index, skipping over anyone who's disconnected
  do {
    gameState.killerTurnIndex++;
    if (gameState.killerTurnIndex >= gameState.killerOrder.length) {
      endGame(roomId, io);
      return;
    }
  } while (gameState.disconnectedSocketIds.has(gameState.killerOrder[gameState.killerTurnIndex]));

  const newKillerId = gameState.killerOrder[gameState.killerTurnIndex];
  gameState.killerId = newKillerId;

  // Tell the OLD killer their turn is over
  io.to(previousKillerId).emit("message", { action: "YOU_ARE_NOT_KILLER", result: "success" });

  // Tell the NEW killer
  io.to(newKillerId).emit("message", { action: "YOU_ARE_KILLER", result: "success" });
}

export function checkForKill(gameState: GameState, io: Server): void {
  const killer = gameState.players.get(gameState.killerId);
  if (!killer || !killer.alive) return;

  for (const [socketId, player] of gameState.players) {
    if (socketId === gameState.killerId) continue;
    if (!player.alive) continue;

    const isSameTile = player.pos.row === killer.pos.row && player.pos.col === killer.pos.col;

    if (isSameTile) {
      player.alive = false;
      killer.kills += 1;

      io.to(gameState.roomId).emit("message", {
        action: "PLAYER_KILLED",
        result: "success",
        payload: { victimSocketId: socketId, killerKills: killer.kills },
      });

      scheduleRespawn(gameState, socketId, io); // new — see below
    }
  }
}

export function scheduleRespawn(gameState: GameState, socketId: string, io: Server): void {
  setTimeout(() => {
    const player = gameState.players.get(socketId);
    const killer = gameState.players.get(gameState.killerId);
    if (!player || !killer) return; // player or killer may have disconnected in the meantime

    const walkableTiles = getWalkableTiles(); // from maze.ts, already built earlier
    const farTiles = walkableTiles.filter((tile) => {
      const dist = Math.abs(tile.row - killer.pos.row) + Math.abs(tile.col - killer.pos.col);
      return dist > 4; // minimum safe distance from killer — tune this number later if needed
    });

    // Fallback: if maze is small and no tile is far enough, just pick any walkable tile
    const pool = farTiles.length > 0 ? farTiles : walkableTiles;
    const spawnTile = pool[Math.floor(Math.random() * pool.length)];

    player.pos = spawnTile;
    player.alive = true;

    io.to(gameState.roomId).emit("message", {
      action: "PLAYER_RESPAWNED",
      result: "success",
      payload: { socketId, pos: spawnTile },
    });
  }, 3000);
}

export function isFullyConnected(): boolean {
  const walkable = getWalkableTiles();
  if (walkable.length === 0) return false;

  const visited = new Set<string>();
  const key = (p: GridPos) => `${p.row},${p.col}`;
  const queue: GridPos[] = [walkable[0]];
  visited.add(key(walkable[0]));

  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [dr, dc] of deltas) {
      const next = { row: current.row + dr, col: current.col + dc };
      if (
        next.row >= 0 && next.row < MAZE_GRID.length &&
        next.col >= 0 && next.col < MAZE_GRID[0].length &&
        MAZE_GRID[next.row][next.col] === 1 &&
        !visited.has(key(next))
      ) {
        visited.add(key(next));
        queue.push(next);
      }
    }
  }

  return visited.size === walkable.length;
}

export function loadCount(): number {
  if (existsSync(COUNT_FILE)) {
    try {
      return JSON.parse(readFileSync(COUNT_FILE, 'utf-8')).count ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function saveCount(count: number) {
  writeFileSync(COUNT_FILE, JSON.stringify({ count }));
}

let visitorCount = loadCount();


export function resolveRematchWindow(room: roomDetails, io: Server) {
  const toRemove: string[] = [];
  room.players.forEach(p => {
    if (!room.rematchVotes.has(p.socketId)) {
      toRemove.push(p.socketId);
    }
  });
  toRemove.forEach(socketId => {
    room.players.delete(socketId);
    io.sockets.sockets.get(socketId)?.leave(room.roomId); // <-- the missing piece
  });

  if (room.players.size === 0) {
    rooms.delete(room.roomId);
    return;
  }
  room.status = "IN_LOBBY";
  room.rematchVotes = new Set();
  room.rematchTimer = null;
  room.rematchDeadline = null;
  io.to(room.roomId).emit("message", { action: "ROOM_RESET", result: "success", payload: roomToPublicState(room) });
} 