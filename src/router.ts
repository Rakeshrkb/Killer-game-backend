import { Server } from 'socket.io';
import { createRoom, joinRoom, kickPlayerFromRoom, setPlayerName, togglePlayerReady, leaveRoom, startGame, movePlayer, playAgain } from './gameRoom';
import { sendMessage } from './chatRoom';
export const routeMessage = (message: any, socket: any, io: Server) => {
    switch (message.action) {
        case "SET_NAME":
            setPlayerName(socket, message.payload.name);
            break;
        case "CREATE_ROOM":
            createRoom(socket);
            break;
        case "JOIN_ROOM":
            joinRoom(socket, message.payload.roomId, io);
            break;
        case "TOGGLE_READY":
            togglePlayerReady(socket, io);
            break;
        case "KICK_PLAYER":
            kickPlayerFromRoom(socket, io, message.payload.socketId);
            break;
        case "LEAVE_ROOM":
            leaveRoom(socket, io);
            break;
        case "START_GAME":
            startGame(socket, io);
            break;
        case "MOVE":
            movePlayer(socket, message.payload.direction, io);
            break;
        case "PLAY_AGAIN":
            playAgain(socket, io);
            break;
        case "SEND_CHAT":
            sendMessage(socket, io, message.payload.text);
            break;
        default:
            console.warn("Unknown action:", message.action);
            socket.emit("message", {
                action: "ERROR",
                result: "failure",
                reason: "Unknown action",
            });
    }
};