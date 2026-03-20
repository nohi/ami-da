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

const signalUrl = import.meta.env.VITE_SIGNAL_URL;
if (!signalUrl || signalUrl.trim().length === 0) {
    throw new Error("VITE_SIGNAL_URL is required");
}

const stunUrl = (import.meta.env.VITE_STUN_URL ?? "").trim();
const rtcConfig: RTCConfiguration = {
    iceServers: stunUrl.length > 0 ? [{ urls: stunUrl }] : [],
};

export class StarRtc {
    private userId: string;
    private roomId = "";
    private ws: WebSocket;
    private hostId = "";
    private peers = new Map<string, { pc: RTCPeerConnection; dc?: RTCDataChannel }>();
    private callbacks: PeerCallbacks;

    constructor(userId: string, callbacks: PeerCallbacks) {
        this.userId = userId;
        this.callbacks = callbacks;
        this.ws = new WebSocket(signalUrl);
        this.ws.addEventListener("message", (e) => this.onSignalMessage(String(e.data)));
    }

    createRoom(): Promise<string> {
        return this.awaitReady(() => {
            this.sendSignal({ type: "create_room", userId: this.userId });
            return new Promise((resolve) => {
                const handler = (ev: MessageEvent) => {
                    const msg = JSON.parse(String(ev.data)) as SignalServerToClient;
                    if (msg.type === "room_created") {
                        this.roomId = msg.roomId;
                        this.hostId = msg.hostId;
                        this.ws.removeEventListener("message", handler);
                        resolve(msg.roomId);
                    }
                };
                this.ws.addEventListener("message", handler);
            });
        });
    }

    async joinRoom(roomId: string): Promise<void> {
        await this.awaitReady(() => {
            this.sendSignal({ type: "join_room", roomId, userId: this.userId });
            return Promise.resolve();
        });
        this.roomId = roomId;
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
            for (const peerId of msg.peers) {
                if (this.userId === this.hostId) {
                    this.ensureHostPeer(peerId).catch(console.error);
                }
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
            this.peers.set(fromUserId, { pc });
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
        this.ws.send(JSON.stringify(msg));
    }

    private async awaitReady<T>(fn: () => Promise<T>): Promise<T> {
        if (this.ws.readyState === WebSocket.OPEN) {
            return fn();
        }
        await new Promise<void>((resolve) => {
            const h = () => {
                this.ws.removeEventListener("open", h);
                resolve();
            };
            this.ws.addEventListener("open", h);
        });
        return fn();
    }
}
