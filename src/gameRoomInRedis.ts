// gameRoomInRedis.ts
import { generateRoomId } from './utils';
import { redis } from './redisClient';
import { Player, sendEventTypes, GamePlayer } from './types';
import { setPlayerNameStore, getPlayerName, addPlayer, getRoom, getRoomStatus, playerExistsInRoom, toggleReady, removePlayerFromRoom, removeRematchVote, getPlayerCount, getRematchVoteCount, deleteRoomEntirely, assignNewHost, getPlayersNotVoted, resetRoomForRematch, setGameGrid, initGamePlayers, getKillerId, getPlayerMoveState, getOtherAlivePositions, updatePlayerPosition, markPlayerDead, incrementKillerKills, addRematchVoteAndCheckFirst, setNewHostForRematch, getGameStandings, setRoomEnded, deleteGame, toPublicRoomState } from './redisUtils';
import { roomKey, gameKey } from './redisClient';
import { scheduleNextRotation, ROTATION_DURATION_MS, cancelRotation } from './rotationScheduler';
import { Server } from "socket.io";
import { pickRandomSpawnTiles, MAZE_GRID, GridPos } from './maze';
import { getGameGrid, clearGridCache } from './gridCache';
import { scheduleRespawn, cancelRespawn } from './respawnScheduler';
import { cancelRematchResolution, scheduleRematchResolution } from './rematchScheduler';
import { getCachedKillerId, setCachedKillerId, clearKillerIdCache } from "./killerIdCache";


export async function setPlayerName(socket: any, name: string) {
    await setPlayerNameStore(socket.id, name);
    socket.name = name;
    socket.emit("message", {
        action: sendEventTypes.NAME_SET,
        result: "success",
        payload: { name },
    });
}


export async function createRoom(socket: any) {
    const roomId = generateRoomId();
    const hostName = (await getPlayerName(socket.id)) || '';

    await redis.hset(roomKey(roomId), {
        hostId: socket.id,
        status: "IN_LOBBY",
        rematchDeadline: "",
    });

    await addPlayer(roomId, {
        socketId: socket.id,
        name: hostName,
        ready: false,
        score: 0,
        status: "CONNECTED",
        isHost: true,
    });

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("message", {
        action: "ROOM_CREATED",
        result: "success",
        payload: {
            roomId,
            hostId: socket.id,
            status: "IN_LOBBY",
            players: [{
                socketId: socket.id,
                name: hostName,
                ready: false,
                score: 0,
                status: "CONNECTED",
                isHost: true,
            }],
        },
    });
}

export async function joinRoom(socket: any, roomId: any, io: Server) {
    const roomHash = await redis.hgetall(roomKey(roomId));

    if (!roomHash || !roomHash.hostId) {
        socket.emit("message", {
            action: "ERROR",
            result: "failure",
            reason: "Room not found",
        });
        return;
    }

    const playerName = (await getPlayerName(socket.id)) || '';

    const newPlayer: Player = {
        socketId: socket.id,
        name: playerName,
        ready: false,
        score: 0,
        status: "CONNECTED",
        isHost: false,
    };

    await addPlayer(roomId, newPlayer);
    socket.join(roomId);
    socket.data.roomId = roomId;

    const roomSnapshot = await getRoom(roomId);
    if (!roomSnapshot) return;

    // Tell the JOINER their full room snapshot
    socket.emit("message", {
        action: "ROOM_JOINED",
        result: "success",
        payload: toPublicRoomState(roomSnapshot),
    });

    // Tell EVERYONE ELSE in the room, across ALL instances, about the new player
    socket.to(roomId).emit("message", {
        action: "PLAYER_JOINED",
        result: "success",
        payload: { player: newPlayer },
    });
}


export async function togglePlayerReady(socket: any, io: Server): Promise<void> {
    const roomId = socket.data.roomId;
    const status = await getRoomStatus(roomId);

    if (!status) {
        return socket.emit("message", {
            action: sendEventTypes.ERROR,
            result: "failure",
            reason: "Room not found",
        });
    }

    if (status !== "IN_LOBBY") {
        return socket.emit("message", {
            action: sendEventTypes.ERROR,
            result: "failure",
            reason: "Cannot toggle ready outside lobby",
        });
    }

    const exists = await playerExistsInRoom(roomId, socket.id);
    if (!exists) {
        return socket.emit("message", {
            action: sendEventTypes.ERROR,
            result: "failure",
            reason: "Player not found in room",
        });
    }

    const newReadyState = await toggleReady(roomId, socket.id);

    io.to(roomId).emit("message", {
        action: sendEventTypes.PLAYER_READY_TOGGLED,
        result: "success",
        payload: { socketId: socket.id, ready: newReadyState },
    });
}

export async function leaveRoom(socket: any, io: Server): Promise<void> {
    const roomId = socket.data.roomId;
    const roomHash = await redis.hgetall(roomKey(roomId));

    if (!roomHash || !roomHash.hostId) {
        return;
    }

    const playerName = (await getPlayerName(socket.id)) || '';
    const wasHost = roomHash.hostId === socket.id;

    await removePlayerFromRoom(roomId, socket.id);
    await removeRematchVote(roomId, socket.id);
    await cancelRespawn(roomId, socket.id);

    socket.to(roomId).emit("message", {
        action: sendEventTypes.PLAYER_LEFT,
        result: "success",
        payload: { socketId: socket.id, name: playerName },
    });

    if (roomHash.status === 'ENDED') {
        const remainingCount = await getPlayerCount(roomId);
        const voteCount = await getRematchVoteCount(roomId);
        if (remainingCount === voteCount) {
            await resolveRematchWindow(roomId, io);
        }
    }

    socket.leave(roomId);

    const remainingCount = await getPlayerCount(roomId);

    if (remainingCount === 0) {
        await deleteRoomEntirely(roomId);
        await deleteGame(roomId);
        await cancelRotation(roomId);
        await cancelRespawn(roomId, socket.id); // this player's own pending respawn, if any
        clearGridCache(roomId);
        clearKillerIdCache(roomId);
    } else if (wasHost) {
        const newHost = await assignNewHost(roomId);
        if (!newHost) return;

        io.to(roomId).emit("message", {
            action: sendEventTypes.HOST_CHANGED,
            result: "success",
            payload: { newHostId: newHost.socketId, newHostName: newHost.name },
        });
    }
}

export async function resolveRematchWindow(roomId: string, io: Server) {
    const toRemove = await getPlayersNotVoted(roomId);

    for (const socketId of toRemove) {
        await removePlayerFromRoom(roomId, socketId);
        io.sockets.sockets.get(socketId)?.leave(roomId);
    }

    const remainingCount = await getPlayerCount(roomId);
    if (remainingCount === 0) {
        await deleteRoomEntirely(roomId);
        return;
    }

    await resetRoomForRematch(roomId);

    const roomSnapshot = await getRoom(roomId);
    if (!roomSnapshot) return;
    io.to(roomId).emit("message", {
        action: "ROOM_RESET",
        result: "success",
        payload: toPublicRoomState(roomSnapshot),
    });
}

export async function disconnectPlayer(socket: any, io: Server): Promise<void> {
    const roomId = socket.data.roomId;
    if (!roomId) return; // socket was never in a room

    const roomHash = await redis.hgetall(roomKey(roomId));
    if (!roomHash || !roomHash.hostId) return; // room already gone

    const wasHost = roomHash.hostId === socket.id;

    await removePlayerFromRoom(roomId, socket.id);
    await removeRematchVote(roomId, socket.id);
    await cancelRespawn(roomId, socket.id);

    io.to(roomId).emit("message", {
        action: sendEventTypes.PLAYER_DISCONNECTED,
        result: "success",
        payload: { socketId: socket.id },
    });

    if (roomHash.status === 'ENDED') {
        const remainingCount = await getPlayerCount(roomId);
        const voteCount = await getRematchVoteCount(roomId);
        if (remainingCount === voteCount) {
            await resolveRematchWindow(roomId, io);
        }
    }

    // TODO: game-state disconnect handling (gameState.players.delete, disconnectedSocketIds,
    // PLAYER_LEFT_THE_GAME emit) — depends on the game:{roomId} player store, which isn't
    // migrated yet since startGame hasn't been done. Revisit once that lands.

    socket.leave(roomId);

    const remainingCount = await getPlayerCount(roomId);
    if (remainingCount === 0) {
        await deleteRoomEntirely(roomId);
    } else if (wasHost) {
        const newHost = await assignNewHost(roomId);
        if (!newHost) return;

        io.to(roomId).emit("message", {
            action: sendEventTypes.HOST_CHANGED,
            result: "success",
            payload: { newHostId: newHost.socketId, newHostName: newHost.name },
        });
    }
}


export async function startGame(socket: any, io: Server): Promise<any> {
    const roomId = socket.data.roomId;
    const roomSnapshot = await getRoom(roomId);

    if (!roomSnapshot) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }
    if (roomSnapshot.hostId !== socket.id) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Start can only be called by Host" });
    }
    if (roomSnapshot.status !== 'IN_LOBBY') {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Game already started" });
    }

    const notReadyPlayers = roomSnapshot.players
        .filter((p) => !p.isHost && !p.ready)
        .map((p) => p.name);

    if (notReadyPlayers.length > 0) {
        let reason: string;
        if (notReadyPlayers.length === 1) {
            reason = `${notReadyPlayers[0]} is not ready`;
        } else if (notReadyPlayers.length === 2) {
            reason = `${notReadyPlayers[0]} and ${notReadyPlayers[1]} are not ready`;
        } else {
            reason = `${notReadyPlayers[0]} and ${notReadyPlayers.length - 1} others are not ready`;
        }
        return io.to(roomId).emit("message", { action: "ERROR", result: "failure", reason });
    }

    await redis.hset(roomKey(roomId), "status", "STARTED");

    const playerIds = roomSnapshot.players.map((p) => p.socketId);
    const spawnTiles = pickRandomSpawnTiles(playerIds.length);

    const gamePlayers: GamePlayer[] = playerIds.map((socketId, index) => {
        const lobbyPlayer = roomSnapshot.players.find((p) => p.socketId === socketId)!;
        return {
            socketId,
            name: lobbyPlayer.name,
            pos: spawnTiles[index],
            alive: true,
            kills: 0,
            lastMoveAt: 0,
        };
    });

    const killerOrder = [...playerIds].sort(() => Math.random() - 0.5);
    const killerId = killerOrder[0];
    setCachedKillerId(roomId, killerId);
    const durationMs = playerIds.length * 20000;

    await redis.hset(`game:${roomId}`, {
        status: "ACTIVE",
        killerOrder: JSON.stringify(killerOrder),
        killerTurnIndex: "0",
        killerId,
        startedAt: String(Date.now()),
        durationMs: String(durationMs),
    });
    await setGameGrid(roomId, MAZE_GRID);
    await initGamePlayers(roomId, gamePlayers);
    await scheduleNextRotation(roomId, ROTATION_DURATION_MS);

    io.to(roomId).emit("message", {
        action: "GAME_STARTED",
        result: "success",
        payload: {
            grid: MAZE_GRID,
            players: gamePlayers,
            durationMs,
        },
    });

    io.to(killerId).emit("message", {
        action: "YOU_ARE_KILLER",
        result: "success",
    });
}

export async function movePlayer(socket: any, direction: string, io: Server): Promise<void> {
    const roomId = socket.data.roomId;
    const grid = await getGameGrid(roomId);
    if (!grid) return;

    const moveState = await getPlayerMoveState(roomId, socket.id);
    if (!moveState || !moveState.alive) return;

    const now = Date.now();
    if (now - moveState.lastMoveAt < 150) return;

    const deltas: Record<string, GridPos> = {
        up: { row: -1, col: 0 }, down: { row: 1, col: 0 },
        left: { row: 0, col: -1 }, right: { row: 0, col: 1 },
    };
    const delta = deltas[direction];
    if (!delta) return;

    const target: GridPos = { row: moveState.pos.row + delta.row, col: moveState.pos.col + delta.col };
    if (target.row < 0 || target.row >= grid.length || target.col < 0 || target.col >= grid[0].length) return;
    if (grid[target.row][target.col] === 0) return;

    const killerId = getCachedKillerId(roomId); // no Redis call at all now
    const isKillerMoving = socket.id === killerId;

    const others = await getOtherAlivePositions(roomId, socket.id); // fetched ONCE

    if (!isKillerMoving) {
        const isOccupied = others.some((p) => p.row === target.row && p.col === target.col);
        if (isOccupied) {
            return socket.emit("message", { action: "MOVE_REJECTED", payload: { reason: "occupied" } });
        }
    }

    await updatePlayerPosition(roomId, socket.id, target.row, target.col, now);

    io.to(roomId).emit("message", {
        action: "PLAYER_MOVED",
        result: "success",
        payload: { socketId: socket.id, pos: target },
    });

    if (!killerId) return;

    if (isKillerMoving) {
        await checkForKill(roomId, killerId, target, others, io);
    }
}

export async function kickPlayerFromRoom(socket: any, io: Server, targetSocketId: string): Promise<void> {
    const roomId = socket.data.roomId;
    const roomSnapshot = await getRoom(roomId);

    if (!roomSnapshot) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }
    if (roomSnapshot.hostId !== socket.id) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Only host can kick players" });
    }
    if (targetSocketId === roomSnapshot.hostId) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Host cannot kick themselves" });
    }

    const kickedPlayer = roomSnapshot.players.find((p) => p.socketId === targetSocketId);

    await removePlayerFromRoom(roomId, targetSocketId);
    await cancelRespawn(roomId, targetSocketId);

    io.to(targetSocketId).emit("message", { action: "KICKED", result: "success" });
    io.sockets.sockets.get(targetSocketId)?.leave(roomId);

    io.to(roomId).emit("message", {
        action: sendEventTypes.PLAYER_KICKED,
        result: "success",
        payload: { socketId: targetSocketId, name: kickedPlayer?.name || '' },
    });
}

export async function checkForKill(
    roomId: string,
    killerId: string,
    killerPos: GridPos,
    others: { socketId: string; row: number; col: number; alive: boolean }[],
    io: Server
): Promise<void> {
    for (const player of others) {
        const isSameTile = player.row === killerPos.row && player.col === killerPos.col;
        if (!isSameTile) continue;

        await markPlayerDead(roomId, player.socketId);
        const killerKills = await incrementKillerKills(roomId, killerId);

        io.to(roomId).emit("message", {
            action: "PLAYER_KILLED",
            result: "success",
            payload: { victimSocketId: player.socketId, killerKills },
        });
        await scheduleRespawn(roomId, player.socketId);
    }
}

export async function playAgain(socket: any, io: Server): Promise<void> {
    const roomId = socket.data.roomId;
    const roomSnapshot = await getRoom(roomId);

    if (!roomSnapshot) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }

    const isPlayerInRoom = roomSnapshot.players.some((p) => p.socketId === socket.id);
    if (!isPlayerInRoom) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Player not found" });
    }

    const { voteCount, isFirstVote } = await addRematchVoteAndCheckFirst(roomId, socket.id);

    let hostId = roomSnapshot.hostId;
    if (isFirstVote) {
        hostId = socket.id;
        await setNewHostForRematch(roomId, socket.id);
    }

    const totalCount = roomSnapshot.players.length;

    io.to(roomId).emit("message", {
        action: "REMATCH_UPDATE",
        result: "success",
        payload: { votedCount: voteCount, totalCount, hostId },
    });

    if (voteCount === totalCount) {
        await cancelRematchResolution(roomId);
        await resolveRematchWindow(roomId, io);
    }
}

export async function endGame(roomId: string, io: Server): Promise<void> {
    const gameExists = await redis.hget(gameKey(roomId), "status");
    if (!gameExists) return;

    const standings = await getGameStandings(roomId); // MUST run before deleteGame
    const rematchDeadline = Date.now() + 15000;

    await setRoomEnded(roomId, rematchDeadline);
    await cancelRotation(roomId);
    await scheduleRematchResolution(roomId, 15000);
    await deleteGame(roomId);
    clearGridCache(roomId);
    clearKillerIdCache(roomId);

    io.to(roomId).emit("message", {
        action: "GAME_ENDED",
        result: "success",
        payload: { standings, rematchDeadline },
    });
}