// ping.ts
import { Socket } from "socket.io";

export function handlePing(socket: Socket, payload: { clientTimestamp: number }) {
    socket.emit("message", {
        action: "PONG",
        result: "success",
        payload: { clientTimestamp: payload.clientTimestamp },
    });
}