export type Role = "host" | "guest";

export type SkillType =
    | "add_rung"
    | "cut_rung"
    | "reverse"
    | "speed_boost"
    | "warp"
    | "jump"
    | "cloak"
    | "vision_jam";

export type LadderRuleSet = {
    allowedSkills: SkillType[];
    maxUsePerSkill: Record<SkillType, number>;
    cooldownMs: Record<SkillType, number>;
    protectedTopDistance: number;
    protectedBottomDistance: number;
};

export type LadderSettings = {
    laneCount: number;
    runnerCount: number;
    drawNames: string[];
    totalHeight: number;
    seed: number;
    rules: LadderRuleSet;
};

export type Rung = {
    id: string;
    laneLeft: number;
    y: number;
    active: boolean;
};

export type RunnerState = {
    userId: string;
    lane: number;
    y: number;
    speed: number;
    reverseUntilMs: number;
    speedBoostUntilMs: number;
    invisibleUntilMs: number;
    visionJammedUntilMs: number;
    finished: boolean;
    resultLane?: number;
};

export type VisualEffect = {
    id: string;
    kind: "warp" | "jump" | "cut";
    lane: number;
    y: number;
    createdAtMs: number;
    durationMs: number;
};

export type PlayerSkillState = {
    usage: Record<SkillType, number>;
    lastUseMs: Record<SkillType, number>;
};

export type LadderSnapshot = {
    status: "waiting" | "running" | "finished";
    serverTimeMs: number;
    settings: LadderSettings;
    rungs: Rung[];
    runners: RunnerState[];
    effects: VisualEffect[];
    skillStateByUserId: Record<string, PlayerSkillState>;
    playerNicknamesByUserId: Record<string, string>;
    visionJammedUntilMsByUserId: Record<string, number>;
    events: string[];
};

export type SkillProposal = {
    kind: "skill_proposal";
    proposalId: string;
    fromUserId: string;
    fromNickname?: string;
    targetUserId: string;
    skill: SkillType;
    payload: {
        laneLeft?: number;
        rungId?: string;
        y?: number;
        durationMs?: number;
    };
    clientTimeMs: number;
};

export type SnapshotRequest = {
    kind: "request_snapshot";
    fromUserId: string;
    fromNickname?: string;
    clientTimeMs: number;
};

export type SkillAccept = {
    kind: "skill_accept";
    proposalId: string;
    byHostId: string;
    appliedAtMs: number;
    snapshot: LadderSnapshot;
};

export type SkillReject = {
    kind: "skill_reject";
    proposalId: string;
    byHostId: string;
    reason: string;
};

export type HostToGuestMessage =
    | { kind: "snapshot"; snapshot: LadderSnapshot }
    | { kind: "countdown"; msLeft: number }
    | { kind: "start"; startedAtMs: number }
    | { kind: "result"; snapshot: LadderSnapshot }
    | SkillAccept
    | SkillReject;

export type GuestToHostMessage = SkillProposal | SnapshotRequest;

export type SignalClientToServer =
    | { type: "create_room"; userId: string }
    | { type: "join_room"; roomId: string; userId: string }
    | { type: "relay"; roomId: string; toUserId: string; fromUserId: string; payload: unknown };

export type SignalServerToClient =
    | { type: "room_created"; roomId: string; hostId: string }
    | { type: "room_joined"; roomId: string; hostId: string; peers: string[] }
    | { type: "peer_joined"; roomId: string; userId: string }
    | { type: "peer_left"; roomId: string; userId: string }
    | { type: "relay"; roomId: string; toUserId: string; fromUserId: string; payload: unknown }
    | { type: "error"; message: string };

export type WasmRuleInput = {
    settings: LadderSettings;
    runner: RunnerState;
    usage: Record<SkillType, number>;
    lastUseMs: Record<SkillType, number>;
    proposal: SkillProposal;
    nowMs: number;
};

export type WasmRuleResult = {
    ok: boolean;
    reason?: string;
    /** 移動先レーン（warp / jump） */
    lane?: number;
    /** 移動先 or rung 配置 Y 座標 */
    y?: number;
    /** スキル持続時間 (ms) */
    durationMs?: number;
    /** speed_boost の速度倍率（デフォルト 1.8）。使用回数で逓減。 */
    speedMultiplier?: number;
    /** add_rung で配置するレーン左端インデックス */
    laneLeft?: number;
};
