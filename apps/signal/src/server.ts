import type { SignalClientToServer, SignalServerToClient } from "@amida/protocol";

type Env = {
  SIGNAL_ROOMS: DurableObjectNamespace;
};

type RoomState = {
  hostId: string;
  members: string[];
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

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
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
      this.stateByRoomId.set(roomId, { hostId: msg.userId, members: [msg.userId] });
      this.socketsByUserId.set(msg.userId, ws);
      this.metaBySocket.set(ws, { roomId, userId: msg.userId });
      this.send(ws, { type: "room_created", roomId, hostId: msg.userId });
      return;
    }

    if (msg.type === "join_room") {
      const room = this.stateByRoomId.get(msg.roomId);
      if (!room) {
        this.send(ws, { type: "error", message: "room not found" });
        return;
      }
      if (!room.members.includes(msg.userId)) {
        room.members.push(msg.userId);
      }
      this.socketsByUserId.set(msg.userId, ws);
      this.metaBySocket.set(ws, { roomId: msg.roomId, userId: msg.userId });
      this.send(ws, {
        type: "room_joined",
        roomId: msg.roomId,
        hostId: room.hostId,
        peers: room.members.filter((u) => u !== msg.userId),
      });
      this.broadcast(msg.roomId, { type: "peer_joined", roomId: msg.roomId, userId: msg.userId }, msg.userId);
      return;
    }

    if (msg.type === "relay") {
      const room = this.stateByRoomId.get(msg.roomId);
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
        roomId: msg.roomId,
        toUserId: msg.toUserId,
        fromUserId: msg.fromUserId,
        payload: msg.payload,
      });
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.removeSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removeSocket(ws);
  }

  private removeSocket(ws: WebSocket): void {
    const meta = this.metaBySocket.get(ws);
    if (!meta) {
      return;
    }
    this.metaBySocket.delete(ws);
    this.socketsByUserId.delete(meta.userId);

    const room = this.stateByRoomId.get(meta.roomId);
    if (!room) {
      return;
    }
    room.members = room.members.filter((u) => u !== meta.userId);
    if (room.members.length === 0 || room.hostId === meta.userId) {
      this.stateByRoomId.delete(meta.roomId);
      return;
    }
    this.broadcast(meta.roomId, { type: "peer_left", roomId: meta.roomId, userId: meta.userId });
  }

  private send(socket: WebSocket, msg: SignalServerToClient): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // noop
    }
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
