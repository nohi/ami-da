import type { LadderRuleSet, LadderSettings, SkillType } from "@amida/protocol";

export const DEFAULT_RULES: LadderRuleSet = {
    allowedSkills: ["add_rung", "cut_rung", "reverse", "speed_boost", "warp", "jump", "cloak", "vision_jam"],
    maxUsePerSkill: {
        add_rung: 6,
        cut_rung: 6,
        reverse: 3,
        speed_boost: 5,
        warp: 3,
        jump: 4,
        cloak: 3,
        vision_jam: 3,
    },
    cooldownMs: {
        add_rung: 1200,
        cut_rung: 1400,
        reverse: 3500,
        speed_boost: 2000,
        warp: 3000,
        jump: 2300,
        cloak: 3200,
        vision_jam: 3800,
    },
    protectedTopDistance: 90,
    protectedBottomDistance: 120,
};

export const SKILL_LABEL: Record<SkillType, string> = {
    add_rung: "線追加",
    cut_rung: "線斬り",
    reverse: "反転",
    speed_boost: "加速",
    warp: "ワープ",
    jump: "ジャンプ",
    cloak: "透明化",
    vision_jam: "視野妨害",
};

export function makeDefaultSettings(laneCount = 6): LadderSettings {
    return {
        laneCount,
        runnerCount: 1,
        totalHeight: 2200,
        seed: (Math.random() * 1_000_000) | 0,
        drawNames: Array.from({ length: laneCount }, (_, i) => `抽選${i + 1}`),
        rules: structuredClone(DEFAULT_RULES),
    };
}
