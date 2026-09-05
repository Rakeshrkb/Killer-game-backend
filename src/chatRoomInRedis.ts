import { Socket, Server } from "socket.io";
import { getRoomStatus, playerExistsInRoom } from "./redisUtils";

export async function sendMessage(socket: Socket, io: Server, message: string): Promise<void> {
    const roomId = socket.data.roomId;
    const trimmed = message.trim().slice(0, 200);
    if (!trimmed) return;

    const status = await getRoomStatus(roomId);
    if (!status) {
        socket.emit("message", { action: "ERROR", result: "failure", reason: "Room not found" });
        return;
    }

    const isInRoom = await playerExistsInRoom(roomId, socket.id);
    if (!isInRoom) {
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
}