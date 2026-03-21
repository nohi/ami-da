import type {
    GuestToHostMessage,
    HostToGuestMessage,
    LadderSettings,
    LadderSnapshot,
    Rung,
    RunnerState,
    SkillProposal,
    SkillType,
    VisualEffect,
} from "@amida/protocol";

type RunnerDirection = 1 | -1;

type InternalRunner = RunnerState & {
    direction: RunnerDirection;
    /** speed_boost 中の速度倍率。 */
    speedBoostMultiplier: number;
    crossing:
    | {
        rungId: string;
        fromLane: number;
        toLane: number;
        y: number;
        progress: number;
        durationSec: number;
    }
    | null;
    lastCrossedRungId: string | null;
};

type SkillDecision = {
    ok: boolean;
    reason?: string;
    lane?: number;
    y?: number;
    durationMs?: number;
    speedMultiplier?: number;
    laneLeft?: number;
};

export class HostEngine {
    private settings: LadderSettings;
    private rungs: Rung[] = [];
    private runners = new Map<string, InternalRunner>();
    private playerNicknames = new Map<string, string>();
    private visionJammedUntilMsByUserId = new Map<string, number>();
    private skillUsage = new Map<string, Record<SkillType, number>>();
    private skillLastUseMs = new Map<string, Record<SkillType, number>>();
    private status: LadderSnapshot["status"] = "waiting";
    private events: string[] = [];
    private effects: VisualEffect[] = [];

    constructor(settings: LadderSettings) {
        this.settings = settings;
        this.generateInitialRungs();
        this.initializeFixedRunners();
    }

    setSettings(next: LadderSettings): void {
        this.settings = next;
        this.rungs = [];
        this.runners.clear();
        this.events = [];
        this.generateInitialRungs();
        this.initializeFixedRunners();
    }

    registerPlayer(userId: string, nickname?: string): void {
        if (nickname && nickname.trim().length > 0) {
            this.playerNicknames.set(userId, nickname.trim());
        } else if (!this.playerNicknames.has(userId)) {
            this.playerNicknames.set(userId, this.defaultNicknameFromUserId(userId));
        }
        if (this.skillUsage.has(userId) && this.skillLastUseMs.has(userId)) {
            return;
        }
        this.visionJammedUntilMsByUserId.set(userId, 0);
        this.skillUsage.set(userId, {
            add_rung: 0,
            cut_rung: 0,
            reverse: 0,
            speed_boost: 0,
            warp: 0,
            jump: 0,
            cloak: 0,
            vision_jam: 0,
        });
        this.skillLastUseMs.set(userId, {
            add_rung: 0,
            cut_rung: 0,
            reverse: 0,
            speed_boost: 0,
            warp: 0,
            jump: 0,
            cloak: 0,
            vision_jam: 0,
        });
    }

    unregisterPlayer(userId: string): void {
        this.playerNicknames.delete(userId);
        this.skillUsage.delete(userId);
        this.skillLastUseMs.delete(userId);
        this.visionJammedUntilMsByUserId.delete(userId);
    }

    private displayName(userId: string): string {
        return this.playerNicknames.get(userId) ?? userId;
    }

    private defaultNicknameFromUserId(userId: string): string {
        const colors = ["赤", "青", "緑", "黄", "紫", "橙", "桃", "白", "黒", "銀"];
        const animals = ["ねこ", "いぬ", "うさぎ", "きつね", "たぬき", "りす", "くま", "ひつじ", "ぺんぎん", "ふくろう"];
        const hash = this.hashText(userId);
        const color = colors[hash % colors.length];
        const animal = animals[Math.floor(hash / colors.length) % animals.length];
        return `${color}${animal}`;
    }

    private hashText(input: string): number {
        let h = 2166136261;
        for (let i = 0; i < input.length; i += 1) {
            h ^= input.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    private initializeFixedRunners(): void {
        const count = Math.max(1, Math.floor(this.settings.runnerCount));
        for (let i = 0; i < count; i += 1) {
            const lane = i % this.settings.laneCount;
            this.createRunner(`runner-${i + 1}`, lane);
        }
    }

    private createRunner(userId: string, lane: number): void {
        const runner: InternalRunner = {
            userId,
            lane,
            y: 0,
            speed: 120,
            reverseUntilMs: 0,
            speedBoostUntilMs: 0,
            invisibleUntilMs: 0,
            visionJammedUntilMs: 0,
            finished: false,
            direction: 1,
            speedBoostMultiplier: 1.8,
            crossing: null,
            lastCrossedRungId: null,
        };
        this.runners.set(userId, runner);
    }

    private resetSkillStates(): void {
        for (const userId of this.skillUsage.keys()) {
            this.skillUsage.set(userId, {
                add_rung: 0,
                cut_rung: 0,
                reverse: 0,
                speed_boost: 0,
                warp: 0,
                jump: 0,
                cloak: 0,
                vision_jam: 0,
            });
            this.skillLastUseMs.set(userId, {
                add_rung: 0,
                cut_rung: 0,
                reverse: 0,
                speed_boost: 0,
                warp: 0,
                jump: 0,
                cloak: 0,
                vision_jam: 0,
            });
        }
    }

    start(): void {
        this.status = "running";
        this.events.push("抽選開始");
    }

    restartRound(): void {
        this.status = "waiting";
        this.rungs = [];
        this.effects = [];
        this.events = ["再抽選準備"];
        this.runners.clear();
        this.generateInitialRungs();
        this.initializeFixedRunners();
        this.resetSkillStates();
        for (const userId of this.visionJammedUntilMsByUserId.keys()) {
            this.visionJammedUntilMsByUserId.set(userId, 0);
        }
    }

    update(nowMs: number, dtSec: number): LadderSnapshot {
        this.effects = this.effects.filter((effect) => nowMs - effect.createdAtMs <= effect.durationMs);

        if (this.status !== "running") {
            return this.snapshot(nowMs);
        }

        for (const runner of this.runners.values()) {
            if (runner.finished) {
                continue;
            }
            if (nowMs <= runner.reverseUntilMs) {
                runner.direction = -1;
            } else {
                runner.direction = 1;
            }

            if (runner.crossing) {
                const cross = runner.crossing;
                cross.progress = Math.min(1, cross.progress + dtSec / cross.durationSec);
                runner.lane = cross.fromLane + (cross.toLane - cross.fromLane) * cross.progress;
                runner.y = cross.y;
                if (cross.progress >= 1) {
                    runner.lane = cross.toLane;
                    runner.lastCrossedRungId = cross.rungId;
                    runner.crossing = null;
                }
            } else {
                const boost = nowMs <= runner.speedBoostUntilMs ? runner.speedBoostMultiplier : 1;
                const delta = runner.speed * boost * dtSec * runner.direction;
                runner.y = Math.max(0, Math.min(this.settings.totalHeight, runner.y + delta));
                this.tryCrossRung(runner);
            }

            if (runner.y >= this.settings.totalHeight) {
                const resultLane = Math.round(runner.lane);
                if (!this.settings.rules.allowDuplicateWinners && this.isLaneAlreadyWon(resultLane, runner.userId)) {
                    const rerollLane = (Math.random() * this.settings.laneCount) | 0;
                    const rerollY = this.randomRespawnY();
                    this.pushEffect("warp", runner.lane, runner.y, nowMs, 620);
                    runner.lane = rerollLane;
                    runner.y = rerollY;
                    runner.crossing = null;
                    runner.lastCrossedRungId = null;
                    this.events.push(`${this.displayName(runner.userId)} は重複回避で再配置`);
                    continue;
                }
                runner.finished = true;
                runner.resultLane = runner.lane;
            }
        }

        if ([...this.runners.values()].every((r) => r.finished)) {
            this.status = "finished";
            this.events.push("全員ゴール");
        }

        return this.snapshot(nowMs);
    }

    onGuestMessage(msg: GuestToHostMessage, nowMs: number): HostToGuestMessage {
        this.registerPlayer(msg.fromUserId, msg.fromNickname);
        if (msg.kind !== "skill_proposal") {
            return { kind: "skill_reject", proposalId: "", byHostId: "host", reason: "unknown message" };
        }
        return this.handleProposal(msg, nowMs);
    }

    private handleProposal(msg: SkillProposal, nowMs: number): HostToGuestMessage {
        if (this.status !== "running") {
            return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "not running" };
        }

        const target = this.runners.get(msg.targetUserId);
        if (!target) {
            return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "target not found" };
        }

        const y = target.y;
        const laneIndex = Math.round(target.lane);
        const decision = this.decideSkill(msg, target, nowMs);
        if (!decision.ok) {
            return {
                kind: "skill_reject",
                proposalId: msg.proposalId,
                byHostId: "host",
                reason: decision.reason ?? "rule violation",
            };
        }

        if (msg.skill === "add_rung") {
            const laneLeft = decision.laneLeft ?? msg.payload.laneLeft ?? Math.max(0, laneIndex - 1);
            if (laneLeft < 0 || laneLeft >= this.settings.laneCount - 1) {
                return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "invalid lane" };
            }
            this.rungs.push({
                id: crypto.randomUUID(),
                laneLeft,
                y: decision.y ?? msg.payload.y ?? y,
                active: true,
            });
            this.events.push(`${this.displayName(msg.fromUserId)} が線追加`);
        }

        if (msg.skill === "cut_rung") {
            const targetRung =
                (msg.payload.rungId ? this.rungs.find((r) => r.active && r.id === msg.payload.rungId) : undefined) ??
                this.findNearestRung(y, laneIndex);
            if (!targetRung) {
                return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "rung not found" };
            }
            targetRung.active = false;
            this.pushEffect("cut", targetRung.laneLeft, targetRung.y, nowMs, 450);
            this.events.push(`${this.displayName(msg.fromUserId)} が線斬り`);
        }

        if (msg.skill === "reverse") {
            this.applyToAllRunners((runner) => {
                runner.reverseUntilMs = nowMs + this.randomizedDuration(decision.durationMs ?? msg.payload.durationMs ?? 2200);
            });
            this.events.push(`${this.displayName(msg.fromUserId)} が反転`);
        }

        if (msg.skill === "speed_boost") {
            this.applyToAllRunners((runner) => {
                runner.speedBoostMultiplier = decision.speedMultiplier ?? 1.8;
                runner.speedBoostUntilMs = nowMs + this.randomizedDuration(decision.durationMs ?? msg.payload.durationMs ?? 1600);
            });
            this.events.push(`${this.displayName(msg.fromUserId)} が加速`);
        }

        if (msg.skill === "warp") {
            const occupiedWarpLanes = new Set<number>();
            for (const runner of this.runners.values()) {
                const fromLane = runner.lane;
                const fromY = runner.y;
                const lane = Math.round(runner.lane);
                const candidateLanes = Array.from({ length: this.settings.laneCount }, (_, i) => i)
                    .filter((v) => v !== lane && !occupiedWarpLanes.has(v));
                const nextLane =
                    candidateLanes.length > 0
                        ? candidateLanes[(Math.random() * candidateLanes.length) | 0]
                        : this.pickRandomOtherLane(lane);
                if (nextLane < 0 || nextLane >= this.settings.laneCount) {
                    return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "invalid warp lane" };
                }
                occupiedWarpLanes.add(nextLane);
                runner.lane = nextLane;
                runner.y = clampNumber(decision.y ?? msg.payload.y ?? runner.y + 80, 0, this.settings.totalHeight);
                this.pushEffect("warp", fromLane, fromY, nowMs, 700);
            }
            this.events.push(`${this.displayName(msg.fromUserId)} がワープ`);
        }

        if (msg.skill === "jump") {
            const fromLane = target.lane;
            const fromY = target.y;
            const delta = msg.payload.laneLeft ?? 2;
            const nextLane = decision.lane ?? clampNumber(laneIndex + Math.max(1, Math.abs(delta)), 0, this.settings.laneCount - 1);
            target.lane = nextLane;
            target.y = clampNumber(decision.y ?? target.y + 45, 0, this.settings.totalHeight);
            this.pushEffect("jump", fromLane, fromY, nowMs, 650);
            this.events.push(`${this.displayName(msg.fromUserId)} がジャンプ`);
        }

        if (msg.skill === "cloak") {
            const duration = decision.durationMs ?? msg.payload.durationMs ?? 2600;
            this.applyToAllRunners((runner) => {
                runner.invisibleUntilMs = nowMs + duration;
            });
            this.events.push(`${this.displayName(msg.fromUserId)} が透明化`);
        }

        if (msg.skill === "vision_jam") {
            const until = nowMs + (decision.durationMs ?? msg.payload.durationMs ?? 2800);
            const allUsers = [...this.skillUsage.keys()].filter((userId) => {
                if (userId === msg.fromUserId) {
                    return false;
                }
                return this.playerNicknames.has(userId);
            });
            const picked = allUsers.length > 0 ? allUsers[(Math.random() * allUsers.length) | 0] : null;
            if (!picked) {
                return { kind: "skill_reject", proposalId: msg.proposalId, byHostId: "host", reason: "target not found" };
            }
            this.visionJammedUntilMsByUserId.set(picked, until);
            this.events.push(`${this.displayName(msg.fromUserId)} が視野妨害`);
        }

        this.consumeSkill(msg.fromUserId, msg.skill, nowMs);

        return {
            kind: "skill_accept",
            proposalId: msg.proposalId,
            byHostId: "host",
            appliedAtMs: nowMs,
            snapshot: this.snapshot(nowMs),
        };
    }

    private isSkillAllowed(userId: string, skill: SkillType, nowMs: number): boolean {
        if (!this.settings.rules.allowedSkills.includes(skill)) {
            return false;
        }
        const usage = this.skillUsage.get(userId);
        const lastUse = this.skillLastUseMs.get(userId);
        if (!usage || !lastUse) {
            return false;
        }
        if (usage[skill] >= this.settings.rules.maxUsePerSkill[skill]) {
            return false;
        }
        if (nowMs - lastUse[skill] < this.settings.rules.cooldownMs[skill]) {
            return false;
        }
        return true;
    }

    private consumeSkill(userId: string, skill: SkillType, nowMs: number): void {
        const usage = this.skillUsage.get(userId);
        const lastUse = this.skillLastUseMs.get(userId);
        if (!usage || !lastUse) {
            return;
        }
        usage[skill] += 1;
        lastUse[skill] = nowMs;
    }

    private snapshot(serverTimeMs: number): LadderSnapshot {
        return {
            status: this.status,
            serverTimeMs,
            settings: this.settings,
            rungs: this.rungs,
            runners: [...this.runners.values()].map((r) => ({
                userId: r.userId,
                lane: r.lane,
                y: r.y,
                speed: r.speed,
                reverseUntilMs: r.reverseUntilMs,
                speedBoostUntilMs: r.speedBoostUntilMs,
                invisibleUntilMs: r.invisibleUntilMs,
                visionJammedUntilMs: r.visionJammedUntilMs,
                finished: r.finished,
                resultLane: r.resultLane,
            })),
            effects: this.effects,
            skillStateByUserId: Object.fromEntries(
                [...this.skillUsage.keys()].map((userId) => {
                    const usage = this.skillUsage.get(userId);
                    const lastUseMs = this.skillLastUseMs.get(userId);
                    return [
                        userId,
                        {
                            usage: usage
                                ? {
                                    add_rung: usage.add_rung,
                                    cut_rung: usage.cut_rung,
                                    reverse: usage.reverse,
                                    speed_boost: usage.speed_boost,
                                    warp: usage.warp,
                                    jump: usage.jump,
                                    cloak: usage.cloak,
                                    vision_jam: usage.vision_jam,
                                }
                                : {
                                    add_rung: 0,
                                    cut_rung: 0,
                                    reverse: 0,
                                    speed_boost: 0,
                                    warp: 0,
                                    jump: 0,
                                    cloak: 0,
                                    vision_jam: 0,
                                },
                            lastUseMs: lastUseMs
                                ? {
                                    add_rung: lastUseMs.add_rung,
                                    cut_rung: lastUseMs.cut_rung,
                                    reverse: lastUseMs.reverse,
                                    speed_boost: lastUseMs.speed_boost,
                                    warp: lastUseMs.warp,
                                    jump: lastUseMs.jump,
                                    cloak: lastUseMs.cloak,
                                    vision_jam: lastUseMs.vision_jam,
                                }
                                : {
                                    add_rung: 0,
                                    cut_rung: 0,
                                    reverse: 0,
                                    speed_boost: 0,
                                    warp: 0,
                                    jump: 0,
                                    cloak: 0,
                                    vision_jam: 0,
                                },
                        },
                    ];
                }),
            ),
            playerNicknamesByUserId: Object.fromEntries(this.playerNicknames),
            visionJammedUntilMsByUserId: Object.fromEntries(this.visionJammedUntilMsByUserId),
            events: this.events.slice(-6),
        };
    }

    private generateInitialRungs(): void {
        const count = this.settings.laneCount * 6;
        const used = new Set<string>();
        for (let i = 0; i < count; i += 1) {
            const laneLeft = (Math.random() * (this.settings.laneCount - 1)) | 0;
            const y = ((i + 1) / (count + 1)) * this.settings.totalHeight;
            const key = `${laneLeft}:${Math.round(y / 24)}`;
            if (used.has(key)) {
                continue;
            }
            used.add(key);
            this.rungs.push({
                id: crypto.randomUUID(),
                laneLeft,
                y,
                active: true,
            });
        }
    }

    private tryCrossRung(runner: InternalRunner): void {
        const threshold = 10;
        const laneIndex = Math.round(runner.lane);
        if (runner.lastCrossedRungId) {
            const last = this.rungs.find((r) => r.id === runner.lastCrossedRungId);
            if (!last || Math.abs(last.y - runner.y) > threshold * 1.5) {
                runner.lastCrossedRungId = null;
            }
        }
        const candidates = this.rungs.filter(
            (r) =>
                r.active &&
                r.id !== runner.lastCrossedRungId &&
                Math.abs(r.y - runner.y) <= threshold &&
                (r.laneLeft === laneIndex || r.laneLeft + 1 === laneIndex),
        );

        if (candidates.length === 0) {
            return;
        }

        const rung = candidates[0];
        if (laneIndex === rung.laneLeft) {
            runner.crossing = {
                rungId: rung.id,
                fromLane: laneIndex,
                toLane: laneIndex + 1,
                y: rung.y,
                progress: 0,
                durationSec: 0.2,
            };
        } else if (laneIndex === rung.laneLeft + 1) {
            runner.crossing = {
                rungId: rung.id,
                fromLane: laneIndex,
                toLane: laneIndex - 1,
                y: rung.y,
                progress: 0,
                durationSec: 0.2,
            };
        }
    }

    private findNearestRung(y: number, lane: number): Rung | undefined {
        return this.rungs
            .filter((r) => r.active && (r.laneLeft === lane || r.laneLeft + 1 === lane))
            .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
    }

    private pickRandomOtherLane(currentLane: number): number {
        if (this.settings.laneCount <= 1) {
            return currentLane;
        }
        let candidate = currentLane;
        while (candidate === currentLane) {
            candidate = (Math.random() * this.settings.laneCount) | 0;
        }
        return candidate;
    }

    private pushEffect(kind: VisualEffect["kind"], lane: number, y: number, nowMs: number, durationMs: number): void {
        this.effects.push({
            id: crypto.randomUUID(),
            kind,
            lane,
            y,
            createdAtMs: nowMs,
            durationMs,
        });
    }

    private applyToAllRunners(fn: (runner: InternalRunner) => void): void {
        for (const runner of this.runners.values()) {
            fn(runner);
        }
    }

    private randomizedDuration(baseMs: number): number {
        const ratio = 0.75 + Math.random() * 0.5;
        return Math.max(300, Math.round(baseMs * ratio));
    }

    private isLaneAlreadyWon(lane: number, selfUserId: string): boolean {
        return [...this.runners.values()].some((r) => r.userId !== selfUserId && r.finished && Math.round(r.resultLane ?? r.lane) === lane);
    }

    private randomRespawnY(): number {
        const minY = Math.max(0, this.settings.totalHeight * 0.25);
        const maxY = Math.max(minY + 1, this.settings.totalHeight * 0.7);
        return minY + Math.random() * (maxY - minY);
    }

    private decideSkill(msg: SkillProposal, target: InternalRunner, nowMs: number): SkillDecision {
        const usage = this.skillUsage.get(msg.fromUserId);
        const lastUse = this.skillLastUseMs.get(msg.fromUserId);
        if (!usage || !lastUse) {
            return { ok: false, reason: "state missing" };
        }

        const top = this.settings.rules.protectedTopDistance;
        const bottom = this.settings.totalHeight - this.settings.rules.protectedBottomDistance;
        if (target.y < top || target.y > bottom) {
            return { ok: false, reason: "protected range" };
        }

        if (!this.isSkillAllowed(msg.fromUserId, msg.skill, nowMs)) {
            return { ok: false, reason: "rule violation" };
        }

        return { ok: true };
    }
}

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
