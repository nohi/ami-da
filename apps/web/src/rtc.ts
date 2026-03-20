import type {
    GuestToHostMessage,
    HostToGuestMessage,
    SignalClientToServer,
    SignalServerToClient,
} from "@amida/protocol";

type PeerCallbacks = {
    onGuestMessage?: (fromUserId: string, msg: GuestToHostMessage) => void;
    onHostMessage?: (msg: HostToGuestMessage) => void;
    onPeerJoined?: (userId: string) => void;
    onPeerLeft?: (userId: string) => void;
    onPeerChannelOpen?: (userId: string) => void;
};

function resolveSignalUrl(): string {
    const fallback = "wss://amida-signal.nohi.workers.dev";
    const raw = (import.meta.env.VITE_SIGNAL_URL ?? "wss://amida-signal.nohi.workers.dev").trim();
    if (raw.length === 0) {
        return fallback;
    }
    const normalized = raw
        .replace(/^https:\/\//i, "wss://")
        .replace(/^http:\/\//i, "ws://");
    const secureAdjusted =
        window.location.protocol === "https:" && /^ws:\/\//i.test(normalized)
            ? normalized.replace(/^ws:\/\//i, "wss://")
            : normalized;
    try {
        const parsed = new URL(secureAdjusted);
        if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
            return parsed.toString();
        }
        return fallback;
    } catch {
        return fallback;
    }
}

const signalUrl = resolveSignalUrl();

const stunUrl = (import.meta.env.VITE_STUN_URL ?? "").trim();
const rtcConfig: RTCConfiguration = {
    iceServers: stunUrl.length > 0 ? [{ urls: stunUrl }] : [],
};

export class StarRtc {
    private userId: string;
    private roomId = "";
    private ws: WebSocket | null = null;
    private hostId = "";
    private peers = new Map<string, { pc: RTCPeerConnection; dc?: RTCDataChannel }>();
    private callbacks: PeerCallbacks;
    private readonly signalTimeoutMs = 12_000;
    private heartbeatTimerId: number | null = null;
    private reconnectTimerId: number | null = null;
    private lastHeartbeatAckMs = 0;
    private readonly heartbeatIntervalMs = 3_000;
    private readonly heartbeatAckTimeoutMs = 9_000;

    constructor(userId: string, callbacks: PeerCallbacks) {
        this.userId = userId;
        this.callbacks = callbacks;
    }

    createRoom(): Promise<string> {
        return this.awaitReady(() => {
            this.sendSignal({ type: "create_room", userId: this.userId });
            return this.waitForSignal(
                (msg): msg is Extract<SignalServerToClient, { type: "room_created" }> => msg.type === "room_created",
                this.signalTimeoutMs,
            ).then((msg) => {
                this.roomId = msg.roomId;
                this.hostId = msg.hostId;
                this.startHostHeartbeat();
                return msg.roomId;
            });
        });
    }

    async joinRoom(roomId: string): Promise<void> {
        await this.awaitReady(() => {
            this.sendSignal({ type: "join_room", roomId, userId: this.userId });
            return this.waitForSignal(
                (msg): msg is Extract<SignalServerToClient, { type: "room_joined" }> =>
                    msg.type === "room_joined" && msg.roomId === roomId,
                this.signalTimeoutMs,
            ).then(() => undefined);
        });
        this.roomId = roomId;
        await this.awaitHostChannelReady(this.signalTimeoutMs);
    }

    isHost(): boolean {
        return this.userId === this.hostId;
    }

    broadcast(msg: HostToGuestMessage): void {
        for (const [, peer] of this.peers) {
            if (peer.dc?.readyState === "open") {
                peer.dc.send(JSON.stringify(msg));
            }
        }
    }

    sendToPeer(userId: string, msg: HostToGuestMessage): void {
        const peer = this.peers.get(userId);
        if (peer?.dc?.readyState === "open") {
            peer.dc.send(JSON.stringify(msg));
        }
    }

    sendToHost(msg: GuestToHostMessage): void {
        const hostPeer = this.peers.get(this.hostId);
        if (hostPeer?.dc?.readyState === "open") {
            hostPeer.dc.send(JSON.stringify(msg));
        }
    }

    private onSignalMessage(raw: string): void {
        const msg = JSON.parse(raw) as SignalServerToClient;

        if (msg.type === "room_joined") {
            this.hostId = msg.hostId;
            if (this.isHost()) {
                this.lastHeartbeatAckMs = Date.now();
                this.startHostHeartbeat();
            }
            for (const peerId of msg.peers) {
                if (this.userId === this.hostId) {
                    this.ensureHostPeer(peerId).catch(console.error);
                }
            }
            return;
        }

        if (msg.type === "heartbeat_ack") {
            if (this.isHost() && msg.roomId === this.roomId) {
                this.lastHeartbeatAckMs = Date.now();
            }
            return;
        }

        if (msg.type === "peer_joined") {
            this.callbacks.onPeerJoined?.(msg.userId);
            if (this.userId === this.hostId) {
                this.ensureHostPeer(msg.userId).catch(console.error);
            }
            return;
        }

        if (msg.type === "peer_left") {
            this.callbacks.onPeerLeft?.(msg.userId);
            const peer = this.peers.get(msg.userId);
            peer?.pc.close();
            this.peers.delete(msg.userId);
            return;
        }

        if (msg.type === "relay") {
            this.handleRelay(msg.fromUserId, msg.payload).catch(console.error);
        }
    }

    private async ensureHostPeer(peerId: string): Promise<void> {
        if (this.peers.has(peerId)) {
            return;
        }
        const pc = new RTCPeerConnection(rtcConfig);
        this.peers.set(peerId, { pc });
        const dc = pc.createDataChannel("game");
        this.bindDataChannel(peerId, dc);

        pc.onicecandidate = (e) => {
            if (!e.candidate) {
                return;
            }
            this.sendSignal({
                type: "relay",
                roomId: this.roomId,
                fromUserId: this.userId,
                toUserId: peerId,
                payload: { kind: "ice", candidate: e.candidate },
            });
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sendSignal({
            type: "relay",
            roomId: this.roomId,
            fromUserId: this.userId,
            toUserId: peerId,
            payload: { kind: "offer", sdp: offer },
        });

        this.peers.set(peerId, { pc, dc });
    }

    private async handleRelay(fromUserId: string, payload: unknown): Promise<void> {
        const p = payload as { kind: "offer" | "answer" | "ice"; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

        if (p.kind === "offer") {
            if (!p.sdp) {
                return;
            }
            const pc = new RTCPeerConnection(rtcConfig);
            this.peers.set(fromUserId, { pc });
            pc.ondatachannel = (event) => this.bindDataChannel(fromUserId, event.channel);
            pc.onicecandidate = (e) => {
                if (!e.candidate) {
                    return;
                }
                this.sendSignal({
                    type: "relay",
                    roomId: this.roomId,
                    fromUserId: this.userId,
                    toUserId: fromUserId,
                    payload: { kind: "ice", candidate: e.candidate },
                });
            };

            await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({
                type: "relay",
                roomId: this.roomId,
                fromUserId: this.userId,
                toUserId: fromUserId,
                payload: { kind: "answer", sdp: answer },
            });
            return;
        }

        const peer = this.peers.get(fromUserId);
        if (!peer) {
            return;
        }

        if (p.kind === "answer" && p.sdp) {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
            return;
        }

        if (p.kind === "ice" && p.candidate) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(p.candidate));
        }
    }

    private bindDataChannel(peerId: string, dc: RTCDataChannel): void {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.dc = dc;
        } else {
            this.peers.set(peerId, { pc: new RTCPeerConnection(rtcConfig), dc });
        }

        dc.onmessage = (e) => {
            const payload = JSON.parse(String(e.data)) as GuestToHostMessage | HostToGuestMessage;
            if (this.userId === this.hostId) {
                this.callbacks.onGuestMessage?.(peerId, payload as GuestToHostMessage);
            } else {
                this.callbacks.onHostMessage?.(payload as HostToGuestMessage);
            }
        };

        dc.onopen = () => {
            this.callbacks.onPeerChannelOpen?.(peerId);
        };
        dc.onclose = () => {
            this.callbacks.onPeerLeft?.(peerId);
            this.peers.delete(peerId);
        };
    }

    private sendSignal(msg: SignalClientToServer): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("signaling socket is not connected");
        }
        this.ws.send(JSON.stringify(msg));
    }

    private async awaitReady<T>(fn: () => Promise<T>): Promise<T> {
        const ws = this.ensureSocket();
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            this.ws = this.createSocket();
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
            return fn();
        }
        await new Promise<void>((resolve, reject) => {
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error("failed to connect signaling socket"));
            };
            const onClose = () => {
                cleanup();
                reject(new Error("signaling socket closed before ready"));
            };
            const timer = window.setTimeout(() => {
                cleanup();
                reject(new Error("timed out waiting signaling connection"));
            }, this.signalTimeoutMs);
            const cleanup = () => {
                window.clearTimeout(timer);
                this.ws?.removeEventListener("open", onOpen);
                this.ws?.removeEventListener("error", onError);
                this.ws?.removeEventListener("close", onClose);
            };
            this.ws?.addEventListener("open", onOpen);
            this.ws?.addEventListener("error", onError);
            this.ws?.addEventListener("close", onClose);
        });
        return fn();
    }

    private ensureSocket(): WebSocket {
        if (!this.ws) {
            this.ws = this.createSocket();
        }
        return this.ws;
    }

    private createSocket(): WebSocket {
        const ws = new WebSocket(signalUrl);
        ws.addEventListener("message", (e) => this.onSignalMessage(String(e.data)));
        ws.addEventListener("close", () => {
            if (this.ws !== ws) {
                return;
            }
            if (this.isHost() && this.roomId.length > 0) {
                this.scheduleHostReconnect();
            }
        });
        return ws;
    }

    private waitForSignal<T extends SignalServerToClient>(
        guard: (msg: SignalServerToClient) => msg is T,
        timeoutMs: number,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const onMessage = (ev: MessageEvent) => {
                let msg: SignalServerToClient;
                try {
                    msg = JSON.parse(String(ev.data)) as SignalServerToClient;
                } catch {
                    return;
                }
                if (msg.type === "error") {
                    cleanup();
                    reject(new Error(`signaling error: ${msg.message}`));
                    return;
                }
                if (!guard(msg)) {
                    return;
                }
                cleanup();
                resolve(msg);
            };
            const onClose = () => {
                cleanup();
                reject(new Error("signaling socket closed while waiting response"));
            };
            const timer = window.setTimeout(() => {
                cleanup();
                reject(new Error("timed out waiting signaling response"));
            }, timeoutMs);
            const cleanup = () => {
                window.clearTimeout(timer);
                this.ws?.removeEventListener("message", onMessage);
                this.ws?.removeEventListener("close", onClose);
            };
            this.ws?.addEventListener("message", onMessage);
            this.ws?.addEventListener("close", onClose);
        });
    }

    private async awaitHostChannelReady(timeoutMs: number): Promise<void> {
        if (this.isHost()) {
            return;
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const hostPeer = this.peers.get(this.hostId);
            if (hostPeer?.dc?.readyState === "open") {
                return;
            }
            await new Promise<void>((resolve) => {
                window.setTimeout(resolve, 120);
            });
        }
        throw new Error("timed out waiting host data channel");
    }

    private startHostHeartbeat(): void {
        if (!this.isHost() || this.roomId.length === 0) {
            return;
        }
        if (this.heartbeatTimerId !== null) {
            window.clearInterval(this.heartbeatTimerId);
            this.heartbeatTimerId = null;
        }
        this.lastHeartbeatAckMs = Date.now();
        this.heartbeatTimerId = window.setInterval(() => {
            const now = Date.now();
            if (now - this.lastHeartbeatAckMs > this.heartbeatAckTimeoutMs) {
                this.scheduleHostReconnect();
                return;
            }
            try {
                this.sendSignal({ type: "heartbeat", userId: this.userId, roomId: this.roomId });
            } catch {
                this.scheduleHostReconnect();
            }
        }, this.heartbeatIntervalMs);
    }

    private scheduleHostReconnect(): void {
        if (!this.isHost() || this.roomId.length === 0) {
            return;
        }
        if (this.reconnectTimerId !== null) {
            return;
        }
        this.reconnectTimerId = window.setTimeout(() => {
            this.reconnectTimerId = null;
            void this.reconnectHostSignal();
        }, 800);
    }

    private async reconnectHostSignal(): Promise<void> {
        if (!this.isHost() || this.roomId.length === 0) {
            return;
        }
        try {
            this.ws = this.createSocket();
            await this.awaitReady(async () => undefined);
            this.sendSignal({ type: "join_room", roomId: this.roomId, userId: this.userId });
            await this.waitForSignal(
                (msg): msg is Extract<SignalServerToClient, { type: "room_joined" }> =>
                    msg.type === "room_joined" && msg.roomId === this.roomId,
                this.signalTimeoutMs,
            );
            this.lastHeartbeatAckMs = Date.now();
            this.startHostHeartbeat();
        } catch {
            this.scheduleHostReconnect();
        }
    }
}
