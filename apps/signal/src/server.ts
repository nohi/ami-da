import type { SignalClientToServer, SignalServerToClient } from "@amida/protocol";

type Env = {
  SIGNAL_ROOMS: DurableObjectNamespace;
};

type RoomState = {
  hostId: string;
  members: string[];
  hostLastSeenMs?: number;
  hostConnected?: boolean;
};

type SocketMeta = {
  roomId: string;
  userId: string;
};

export class SignalRoom {
  private state: DurableObjectState;
  private socketsByUserId = new Map<string, WebSocket>();
  private stateByRoomId = new Map<string, RoomState>();
  private metaBySocket = new Map<WebSocket, SocketMeta>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: SignalClientToServer;
    try {
      msg = JSON.parse(text) as SignalClientToServer;
    } catch {
      this.send(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (msg.type === "create_room") {
      const roomId = makeRoomId();
      const roomState: RoomState = {
        hostId: msg.userId,
        members: [msg.userId],
        hostLastSeenMs: Date.now(),
        hostConnected: true,
      };
      this.stateByRoomId.set(roomId, roomState);
      await this.state.storage.put(`room:${roomId}`, roomState);
      this.bindSocket(roomId, msg.userId, ws);
      this.send(ws, { type: "room_created", roomId, hostId: msg.userId });
      return;
    }

    if (msg.type === "heartbeat") {
      const roomId = msg.roomId?.trim().toUpperCase();
      if (!roomId) {
        return;
      }
      const room = await this.getRoom(roomId);
      if (!room) {
        return;
      }
      if (room.hostId !== msg.userId) {
        return;
      }
      room.hostLastSeenMs = Date.now();
      room.hostConnected = true;
      this.stateByRoomId.set(roomId, room);
      await this.state.storage.put(`room:${roomId}`, room);
      this.send(ws, { type: "heartbeat_ack", roomId, atMs: Date.now() });
      return;
    }

    if (msg.type === "join_room") {
      const roomId = msg.roomId.trim().toUpperCase();
      const room = await this.getRoom(roomId);
      if (!room) {
        this.send(ws, { type: "error", message: "room not found" });
        return;
      }
      const hostSocket = this.socketsByUserId.get(room.hostId);
      if (!hostSocket) {
        if (Date.now() - (room.hostLastSeenMs ?? 0) > HOST_RECONNECT_GRACE_MS) {
          this.stateByRoomId.delete(roomId);
          await this.state.storage.delete(`room:${roomId}`);
          this.send(ws, { type: "error", message: "room expired (host offline too long)" });
          return;
        }
        this.send(ws, { type: "error", message: "host offline" });
        return;
      }
      if (!room.members.includes(msg.userId)) {
        room.members.push(msg.userId);
      }
      if (msg.userId === room.hostId) {
        room.hostConnected = true;
        room.hostLastSeenMs = Date.now();
      }
      this.stateByRoomId.set(roomId, room);
      await this.state.storage.put(`room:${roomId}`, room);
      this.bindSocket(roomId, msg.userId, ws);
      this.send(ws, {
        type: "room_joined",
        roomId,
        hostId: room.hostId,
        peers: room.members.filter((u) => u !== msg.userId),
      });
      this.broadcast(roomId, { type: "peer_joined", roomId, userId: msg.userId }, msg.userId);
      return;
    }

    if (msg.type === "relay") {
      const roomId = msg.roomId.trim().toUpperCase();
      const room = await this.getRoom(roomId);
      if (!room) {
        this.send(ws, { type: "error", message: "room not found" });
        return;
      }
      const target = this.socketsByUserId.get(msg.toUserId);
      if (!target) {
        this.send(ws, { type: "error", message: "target not found" });
        return;
      }
      this.send(target, {
        type: "relay",
        roomId,
        toUserId: msg.toUserId,
        fromUserId: msg.fromUserId,
        payload: msg.payload,
      });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.removeSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.removeSocket(ws);
  }

  private async removeSocket(ws: WebSocket): Promise<void> {
    const meta = this.metaBySocket.get(ws);
    if (!meta) {
      return;
    }
    this.metaBySocket.delete(ws);
    if (this.socketsByUserId.get(meta.userId) === ws) {
      this.socketsByUserId.delete(meta.userId);
    }

    const room = await this.getRoom(meta.roomId);
    if (!room) {
      return;
    }

    // Keep host-only rooms reserved for host reconnect after transient disconnects.
    if (room.hostId === meta.userId && room.members.length === 1 && room.members[0] === meta.userId) {
      room.hostLastSeenMs = Date.now();
      room.hostConnected = false;
      this.stateByRoomId.set(meta.roomId, room);
      await this.state.storage.put(`room:${meta.roomId}`, room);
      return;
    }

    room.members = room.members.filter((u) => u !== meta.userId);
    if (room.members.length === 0 || room.hostId === meta.userId) {
      this.stateByRoomId.delete(meta.roomId);
      await this.state.storage.delete(`room:${meta.roomId}`);
      return;
    }
    await this.state.storage.put(`room:${meta.roomId}`, room);
    this.broadcast(meta.roomId, { type: "peer_left", roomId: meta.roomId, userId: meta.userId });
  }

  private async getRoom(roomId: string): Promise<RoomState | null> {
    const inMemory = this.stateByRoomId.get(roomId);
    if (inMemory) {
      return inMemory;
    }
    const stored = await this.state.storage.get<RoomState>(`room:${roomId}`);
    if (stored) {
      this.stateByRoomId.set(roomId, stored);
      return stored;
    }
    return null;
  }

  private send(socket: WebSocket, msg: SignalServerToClient): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // noop
    }
  }

  private bindSocket(roomId: string, userId: string, ws: WebSocket): void {
    const existing = this.socketsByUserId.get(userId);
    if (existing && existing !== ws) {
      this.metaBySocket.delete(existing);
    }
    this.socketsByUserId.set(userId, ws);
    this.metaBySocket.set(ws, { roomId, userId });
  }

  private broadcast(roomId: string, msg: SignalServerToClient, exceptUserId?: string): void {
    const room = this.stateByRoomId.get(roomId);
    if (!room) {
      return;
    }
    for (const uid of room.members) {
      if (uid === exceptUserId) {
        continue;
      }
      const socket = this.socketsByUserId.get(uid);
      if (socket) {
        this.send(socket, msg);
      }
    }
  }
}

const HOST_RECONNECT_GRACE_MS = 45_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("websocket only", { status: 426 });
    }
    const id = env.SIGNAL_ROOMS.idFromName("global");
    const room = env.SIGNAL_ROOMS.get(id);
    return room.fetch(request);
  },
};

function makeRoomId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
