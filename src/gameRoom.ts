import { roomDetails, Player } from './types';
import { Server } from 'socket.io';
import { generateRoomId, rotateKiller, checkForKill, resolveRematchWindow } from './utils';
import { sendEventTypes } from './types';
import { MAZE_GRID, pickRandomSpawnTiles, GridPos } from './maze';
import { GamePlayer, GameState } from './types';
import { ROTATION_DURATION_MS, scheduleNextRotation, cancelRotation } from './rotationScheduler';
import { redis } from './redisClient';

export const rooms = new Map<string, roomDetails>();
export const playerNames = new Map<string, string>();
export const gameStates = new Map<string, GameState>();


export function setPlayerName(socket: any, name: string) {
    playerNames.set(socket.id, name);
    socket.emit("message", {
        action: sendEventTypes.NAME_SET,
        result: "success",
        payload: { name },
    });
}

export function broadcastRoomUpdate(io: Server, room: roomDetails) {
    io.to(room.roomId).emit("message", {
        action: sendEventTypes.ROOM_UPDATED,
        result: "success",
        payload: room,
    });
}

export function togglePlayerReady(socket: any, io: Server): void {
    const room = rooms.get(socket.data.roomId);
    if (room) {
        const player = room.players.get(socket.id);
        if (room.status !== 'IN_LOBBY') {
            return socket.emit("message", {
                action: sendEventTypes.ERROR,
                result: "failure",
                reason: "Cannot toggle ready outside lobby",
            });
        }
        if (player) {
            player.ready = !player.ready;
            io.to(room.roomId).emit("message", {
                action: sendEventTypes.PLAYER_READY_TOGGLED,
                result: "success",
                payload: { socketId: socket.id, ready: player.ready },
            });
        } else {
            socket.emit("message", {
                action: sendEventTypes.ERROR,
                result: "failure",
                reason: "Player not found in room",
            });
        }
    } else {
        socket.emit("message", {
            action: sendEventTypes.ERROR,
            result: "failure",
            reason: "Room not found",
        });
    }
}

export function createRoom(socket: any) {
    const roomId = generateRoomId();
    const room: roomDetails = {
        roomId,
        hostId: socket.id,
        status: 'IN_LOBBY',
        players: new Map<string, Player>(),
        rematchVotes: new Set(),
        rematchDeadline: null,
        rematchTimer: null
    };
    room.players.set(socket.id, {
        socketId: socket.id,
        name: playerNames.get(socket.id) || '',
        ready: false,
        score: 0,
        status: 'CONNECTED',
        isHost: true,
    });
    rooms.set(room.roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("message", {
        action: "ROOM_CREATED",
        result: "success",
        payload: roomToPublicState(room),
    });
}

export function joinRoom(socket: any, roomId: any, io: Server): void {
    const room = rooms.get(roomId);
    if (room) {
        const newPlayer: Player = {
            socketId: socket.id,
            name: playerNames.get(socket.id) || '',
            ready: false,
            score: 0,
            status: 'CONNECTED',
            isHost: false,
        };
        room.players.set(socket.id, newPlayer);
        socket.join(roomId);
        socket.data.roomId = roomId; // also fixes togglePlayerReady if you switched to socket.data pattern

        // Tell the JOINER their full room snapshot
        socket.emit("message", {
            action: "ROOM_JOINED",
            result: "success",
            payload: roomToPublicState(room),
        });
        // Tell EVERYONE ELSE just the new player
        socket.to(roomId).emit("message", {
            action: "PLAYER_JOINED",
            result: "success",
            payload: { player: newPlayer },
        });
    } else {
        socket.emit("message", {
            action: "ERROR",
            result: "failure",
            reason: "Room not found",
        });
    }
}

export function roomToPublicState(room: roomDetails) {
    return {
        roomId: room.roomId,
        hostId: room.hostId,
        status: room.status,
        players: Array.from(room.players.values()), // Map → array, now JSON-safe
    };
}

export function leaveRoom(socket: any, io: Server): void {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    if (room) {
        let playerName = playerNames.get(socket.id) || '';
        room.players.delete(socket.id);
        room.rematchVotes.delete(socket.id);
        socket.to(roomId).emit("message", {
            action: sendEventTypes.PLAYER_LEFT,
            result: "success",
            payload: { socketId: socket.id, name: playerName },
        });
        if (room.status === 'ENDED') {
            if (room.players.size === room.rematchVotes.size) {
                resolveRematchWindow(room, io);
            }
        }
        socket.leave(roomId);
        if (room.players.size === 0) {
            rooms.delete(roomId);
        } else if (room.hostId === socket.id) {
            // If the host leaves, assign a new host
            const newHostId = room.players.keys().next().value;
            if (!newHostId) {
                return;
            }
            room.hostId = newHostId;
            room.players.get(newHostId)!.isHost = true;
            io.to(roomId).emit("message", {
                action: sendEventTypes.HOST_CHANGED,
                result: "success",
                payload: { newHostId, newHostName: room.players.get(newHostId)!.name },
            });
        }
    } else {
        socket.emit("message", {
            action: "ERROR",
            result: "failure",
            reason: "Room not found",
        });
    }
}

// disconnect player from all rooms they are part of
export function disconnectPlayer(socket: any, io: Server): void {
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.has(socket.id)) {
            room.players.delete(socket.id);
            if (room.rematchVotes.has(socket.id)) {
                room.rematchVotes.delete(socket.id);
            }
            if (room.status === "ENDED") {
                if (room.players.size === room.rematchVotes.size) {
                    resolveRematchWindow(room, io);
                }
            }
            io.to(roomId).emit("message", {
                action: sendEventTypes.PLAYER_DISCONNECTED,
                result: "success",
                payload: { socketId: socket.id },
            });
            const gameState = gameStates.get(roomId);
            if (gameState) {
                const player = gameState.players.get(socket.id);
                if (player) {
                    gameState.disconnectedSocketIds.add(socket.id);
                    gameState.players.delete(socket.id);
                    io.to(roomId).emit("message", {
                        action: "PLAYER_LEFT_THE_GAME",
                        result: "success",
                        payload: { socketId: socket.id, name: player.name },
                    });
                }
            }
            socket.leave(roomId);
            if (room.players.size === 0) {
                rooms.delete(roomId);
            } else if (room.hostId === socket.id) {
                // If the host disconnects, assign a new host
                const newHostId = room.players.keys().next().value;
                if (!newHostId) {
                    return;
                }
                room.hostId = newHostId;
                room.players.get(newHostId)!.isHost = true;
                io.to(roomId).emit("message", {
                    action: sendEventTypes.HOST_CHANGED,
                    result: "success",
                    payload: { newHostId, newHostName: room.players.get(newHostId)!.name },
                });
            }
        }
    }
}

// Kick player from a room (only host can do this)
export function kickPlayerFromRoom(socket: any, io: Server, targetSocketId: string): void {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }
    if (room.hostId !== socket.id) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Only host can kick players" });
    }
    if (targetSocketId === room.hostId) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Host cannot kick themselves" });
    }
    const kickedPlayer = room.players.get(targetSocketId);
    room.players.delete(targetSocketId);

    // tell the kicked player specifically
    io.to(targetSocketId).emit("message", { action: "KICKED", result: "success" });

    // remove them from the Socket.IO room so they stop receiving room broadcasts
    io.sockets.sockets.get(targetSocketId)?.leave(roomId);

    // tell everyone else who got kicked
    io.to(roomId).emit("message", {
        action: sendEventTypes.PLAYER_KICKED,
        result: "success",
        payload: { socketId: targetSocketId, name: kickedPlayer?.name || '' },
    });

}

// Start Game callable by Host
export function startGame(socket: any, io: Server): any {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }
    if (room.hostId !== socket.id) {
        return socket.emit("message", { action: "ERROR", result: "failure", reson: "Start can only callable by Host" });
    }
    if (room.status !== 'IN_LOBBY') {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Game already started" });
    }
    const notReadyPlayers = Array.from(room.players.values())
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
    room.status = "STARTED";

    const playerIds = Array.from(room.players.keys());
    const spawnTiles = pickRandomSpawnTiles(playerIds.length);

    const gamePlayers = new Map<string, GamePlayer>();
    playerIds.forEach((socketId, index) => {
        const lobbyPlayer = room.players.get(socketId)!;
        gamePlayers.set(socketId, {
            socketId,
            name: lobbyPlayer.name,
            pos: spawnTiles[index],
            alive: true,
            kills: 0,
            lastMoveAt: 0
        });
    });

    const killerOrder = [...playerIds].sort(() => Math.random() - 0.5);
    const killerTurnIndex = 0;
    const killerId = killerOrder[killerTurnIndex];
    redis.hset(`game:${roomId}`, {
        status: "ACTIVE",
        killerOrder: JSON.stringify(killerOrder),
        killerTurnIndex: 0,
        killerId: killerOrder[0],
    });
    scheduleNextRotation(roomId, ROTATION_DURATION_MS);

    const gameState: GameState = {
        roomId,
        grid: MAZE_GRID,
        players: gamePlayers,
        killerId,
        killerOrder,
        killerTurnIndex,
        rotationTimer: null, // we'll set this up next
        startedAt: Date.now(),
        durationMs: playerIds.length * 20000,
        disconnectedSocketIds: new Set()
    };
    gameState.rotationTimer = setInterval(() => {
        rotateKiller(roomId, io);
    }, ROTATION_DURATION_MS);
    gameStates.set(roomId, gameState);

    // Broadcast to everyone — grid, player positions, duration. NO killer info here.
    io.to(roomId).emit("message", {
        action: "GAME_STARTED",
        result: "success",
        payload: {
            grid: gameState.grid,
            players: Array.from(gameState.players.values()),
            durationMs: gameState.durationMs,
        },
    });

    // Privately tell ONLY the killer who they are
    io.to(killerId).emit("message", {
        action: "YOU_ARE_KILLER",
        result: "success",
    });
}


export function movePlayer(socket: any, direction: string, io: Server): void {
    const roomId = socket.data.roomId;
    const gameState = gameStates.get(roomId);
    if (!gameState) return;

    const player = gameState.players.get(socket.id);
    if (!player || !player.alive) return;

    const now = Date.now();
    if (now - player.lastMoveAt < 150) return; // cooldown, silently ignore spam

    const deltas: Record<string, GridPos> = {
        up: { row: -1, col: 0 },
        down: { row: 1, col: 0 },
        left: { row: 0, col: -1 },
        right: { row: 0, col: 1 },
    };
    const delta = deltas[direction];
    if (!delta) return;

    const target: GridPos = {
        row: player.pos.row + delta.row,
        col: player.pos.col + delta.col,
    };

    // bounds check
    if (
        target.row < 0 || target.row >= gameState.grid.length ||
        target.col < 0 || target.col >= gameState.grid[0].length
    ) return;

    // wall check
    if (gameState.grid[target.row][target.col] === 0) return;

    // occupied check — is any OTHER alive player already standing on the target tile?
    const isKillerMoving = socket.id === gameState.killerId;
    if (!isKillerMoving) {
        const isOccupied = Array.from(gameState.players.values()).some(
            (p) =>
                p.socketId !== socket.id &&
                p.alive &&
                p.pos.row === target.row &&
                p.pos.col === target.col
        );
        if (isOccupied) {
            return socket.emit("message", { action: "MOVE_REJECTED", payload: { reason: "occupied" } });
        }
    }

    // move is valid
    player.pos = target;
    player.lastMoveAt = now;

    io.to(roomId).emit("message", {
        action: "PLAYER_MOVED",
        result: "success",
        payload: { socketId: socket.id, pos: target },
    });
    checkForKill(gameState, io);
}

export function endGame(roomId: string, io: Server): void {
    const gameState = gameStates.get(roomId);
    if (!gameState) return;

    const room = rooms.get(roomId);
    if (room) {
        room.status = 'ENDED';
        room.rematchVotes = new Set()
        room.rematchDeadline = Date.now() + 15000;
        room.rematchTimer = setTimeout(() => resolveRematchWindow(room, io), 15000);
    }

    if (gameState.rotationTimer) {
        clearInterval(gameState.rotationTimer);
    }

    const standings = Array.from(gameState.players.values())
        .map((p) => ({ socketId: p.socketId, name: p.name, kills: p.kills }))
        .sort((a, b) => b.kills - a.kills);
    if (!room) return;
    io.to(roomId).emit("message", {
        action: "GAME_ENDED",
        result: "success",
        payload: { standings, rematchDeadline: room.rematchDeadline },
    });

    gameStates.delete(roomId);
    cancelRotation(roomId);
}

export function playAgain(socket: any, io: Server): void {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
    }
    const playerIds = Array.from(room.players.keys());
    if (!playerIds.includes(socket.id)) {
        return socket.emit("message", { action: "ERROR", result: "failure", reason: "Player not found" });
    }
    room.rematchVotes.add(socket.id);
    if (room.rematchVotes.size === 1) {
        room.hostId = socket.id;
        room.players.forEach(p => {
            if (p.socketId != socket.id) {
                p.isHost = false;
            } else {
                p.isHost = true;
            }
        })
    }
    io.to(roomId).emit("message", { action: "REMATCH_UPDATE", result: "success", payload: { votedCount: room.rematchVotes.size, totalCount: room.players.size, hostId: room.hostId } })

    if (room.rematchVotes.size === room.players.size) {
        if (room.rematchTimer) {
            clearTimeout(room.rematchTimer);
        }
        resolveRematchWindow(room, io);
    }

}