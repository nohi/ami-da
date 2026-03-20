import { WebSocketServer, type WebSocket } from "ws";
import type { SignalClientToServer, SignalServerToClient } from "@amida/protocol";

type Room = {
  hostId: string;
  members: Map<string, WebSocket>;
};

const wss = new WebSocketServer({ port: 8787 });
const rooms = new Map<string, Room>();
const socketMeta = new Map<WebSocket, { userId: string; roomId: string }>();

function send(socket: WebSocket, msg: SignalServerToClient): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function broadcast(room: Room, msg: SignalServerToClient, exceptUserId?: string): void {
  for (const [uid, ws] of room.members) {
    if (uid !== exceptUserId) {
      send(ws, msg);
    }
  }
}

function makeRoomId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    let msg: SignalClientToServer;
    try {
      msg = JSON.parse(String(data)) as SignalClientToServer;
    } catch {
      send(socket, { type: "error", message: "invalid json" });
      return;
    }

    if (msg.type === "create_room") {
      const roomId = makeRoomId();
      const room: Room = {
        hostId: msg.userId,
        members: new Map([[msg.userId, socket]]),
      };
      rooms.set(roomId, room);
      socketMeta.set(socket, { userId: msg.userId, roomId });
      send(socket, { type: "room_created", roomId, hostId: msg.userId });
      return;
    }

    if (msg.type === "join_room") {
      const room = rooms.get(msg.roomId);
      if (!room) {
        send(socket, { type: "error", message: "room not found" });
        return;
      }
      room.members.set(msg.userId, socket);
      socketMeta.set(socket, { userId: msg.userId, roomId: msg.roomId });
      send(socket, {
        type: "room_joined",
        roomId: msg.roomId,
        hostId: room.hostId,
        peers: [...room.members.keys()].filter((u) => u !== msg.userId),
      });
      broadcast(room, { type: "peer_joined", roomId: msg.roomId, userId: msg.userId }, msg.userId);
      return;
    }

    if (msg.type === "relay") {
      const room = rooms.get(msg.roomId);
      if (!room) {
        send(socket, { type: "error", message: "room not found" });
        return;
      }
      const target = room.members.get(msg.toUserId);
      if (!target) {
        send(socket, { type: "error", message: "target not found" });
        return;
      }
      send(target, {
        type: "relay",
        roomId: msg.roomId,
        toUserId: msg.toUserId,
        fromUserId: msg.fromUserId,
        payload: msg.payload,
      });
    }
  });

  socket.on("close", () => {
    const meta = socketMeta.get(socket);
    if (!meta) {
      return;
    }
    socketMeta.delete(socket);
    const room = rooms.get(meta.roomId);
    if (!room) {
      return;
    }
    room.members.delete(meta.userId);
    if (room.members.size === 0 || room.hostId === meta.userId) {
      rooms.delete(meta.roomId);
      return;
    }
    broadcast(room, { type: "peer_left", roomId: meta.roomId, userId: meta.userId });
  });
});

console.log("Signaling server started at ws://localhost:8787");
