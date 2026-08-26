import { Socket, Server } from "socket.io";
import { rooms } from "./gameRoom";

export function sendMessage(socket: Socket, io: Server, message: string): void {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const trimmed = message.trim().slice(0, 200);
    if (!trimmed) return;
    if (!room) {
        socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
        return;
    }
    if (!room.players.has(socket.id)) {
        socket.emit("message", { action: "ERROR", result: "failure", reason: "You are not allowed to send msg in a room where you don't belong" });
        return;
    }

    io.to(roomId).emit("message", {
        action: "CHAT_MESSAGE",
        result: "success",
        payload: {
            socketId: socket.id,
            text: trimmed,
            timestamp: Date.now(),
        },
    });
};