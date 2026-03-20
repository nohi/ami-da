import { Application, Container, Graphics, Text } from "pixi.js";
import type { LadderSnapshot } from "@amida/protocol";

// --- イージング関数 ---

function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
}

function easeOutExpo(t: number): number {
    return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
}

function easeInQuad(t: number): number {
    return t * t;
}

export class GameView {
    readonly app: Application;
    readonly stageRoot = new Container();
    readonly lanes = new Graphics();
    readonly laneLabels = new Container();
    readonly rungs = new Graphics();
    readonly runners = new Graphics();
    readonly effects = new Graphics();
    readonly visionMask = new Graphics();
    readonly info = new Text({
        text: "",
        style: { fill: 0xe7f3ff, fontSize: 14 },
    });

    constructor(app: Application) {
        this.app = app;
        this.app.stage.addChild(this.stageRoot);
        this.stageRoot.addChild(this.lanes);
        this.stageRoot.addChild(this.laneLabels);
        this.stageRoot.addChild(this.rungs);
        this.stageRoot.addChild(this.runners);
        this.stageRoot.addChild(this.effects);
        this.stageRoot.addChild(this.visionMask);
        this.stageRoot.addChild(this.info);
        this.info.position.set(12, 12);
    }

    /**
     * @param snapshot      最新のラダースナップショット
     * @param localUserId   このデバイスでプレイしているユーザーID（視野妨害の判定に使用）
     */
    render(snapshot: LadderSnapshot, localUserId?: string): void {
        const w = this.app.screen.width;
        const h = this.app.screen.height;
        const skillBarReserve = snapshot.status === "running" ? 98 : 0;
        const bottomY = h - 30 - skillBarReserve;
        const labelY = h - 24 - skillBarReserve;
        const marginX = 70;
        const laneGap = (w - marginX * 2) / Math.max(1, snapshot.settings.laneCount - 1);

        this.lanes.clear();
        this.laneLabels.removeChildren().forEach((child) => child.destroy());
        this.rungs.clear();
        this.runners.clear();
        this.effects.clear();
        this.visionMask.clear();

        for (let i = 0; i < snapshot.settings.laneCount; i += 1) {
            const x = marginX + i * laneGap;
            this.lanes.moveTo(x, 40);
            this.lanes.lineTo(x, bottomY);
        }
        this.lanes.stroke({ color: 0x8ec3ff, width: 3, alpha: 0.8 });

        for (let i = 0; i < snapshot.settings.laneCount; i += 1) {
            const x = marginX + i * laneGap;
            const label = new Text({
                text: snapshot.settings.drawNames[i] ?? `抽選${i + 1}`,
                style: { fill: 0xd7e9ff, fontSize: 13 },
            });
            label.anchor.set(0.5, 0);
            label.position.set(x, labelY);
            this.laneLabels.addChild(label);
        }

        const yScale = (bottomY - 40) / snapshot.settings.totalHeight;

        for (const rung of snapshot.rungs) {
            if (!rung.active) {
                continue;
            }
            const x1 = marginX + rung.laneLeft * laneGap;
            const x2 = x1 + laneGap;
            const y = 40 + rung.y * yScale;
            this.rungs.moveTo(x1, y);
            this.rungs.lineTo(x2, y);
        }
        this.rungs.stroke({ color: 0xf4b400, width: 5, alpha: 0.9 });

        for (const runner of snapshot.runners) {
            const cloaked = runner.invisibleUntilMs > snapshot.serverTimeMs;
            if (cloaked) {
                continue;
            }
            const x = marginX + runner.lane * laneGap;
            const y = 40 + runner.y * yScale;
            const color = runner.finished ? 0x65d28d : 0xf85b5b;
            this.runners.circle(x, y, 11).fill({ color, alpha: 1 });

            // 視野妨害中のランナーにオーラを表示（全員に見える）
            if (runner.visionJammedUntilMs > snapshot.serverTimeMs) {
                const pulse = 0.6 + 0.4 * Math.sin(snapshot.serverTimeMs * 0.008);
                this.runners.circle(x, y, 16).stroke({ color: 0x9b59b6, width: 2.5, alpha: 0.7 * pulse });
            }
        }

        // --- エフェクト描画（時間補間 + 残像） ---
        for (const effect of snapshot.effects) {
            const ex = marginX + effect.lane * laneGap;
            const ey = 40 + effect.y * yScale;
            const age = snapshot.serverTimeMs - effect.createdAtMs;
            const t = Math.min(1, Math.max(0, age / effect.durationMs));

            if (effect.kind === "warp") {
                this.drawWarpEffect(ex, ey, t);
            } else if (effect.kind === "jump") {
                this.drawJumpEffect(ex, ey, t);
            } else if (effect.kind === "cut") {
                this.drawCutEffect(ex, ey, t);
            }
        }

        // --- 視野妨害オーバーレイ（ローカルプレイヤーのみ） ---
        const localRunner = localUserId
            ? snapshot.runners.find((r) => r.userId === localUserId)
            : undefined;
        const fallbackRunner = snapshot.runners.find((r) => !r.finished) ?? snapshot.runners[0];
        const localJammedUntil = localUserId ? (snapshot.visionJammedUntilMsByUserId[localUserId] ?? 0) : 0;
        const localIsJammed = localJammedUntil > snapshot.serverTimeMs;
        const jamTarget = localIsJammed ? (localRunner ?? fallbackRunner) : undefined;
        if (jamTarget) {
            const cx = marginX + jamTarget.lane * laneGap;
            const cy = 40 + jamTarget.y * yScale;
            const radius = 78 + 6 * Math.sin(snapshot.serverTimeMs * 0.01);
            const darkness = 0.95;
            const stripeH = 6;

            // 円外のみを高い不透明度で塗り、視界を厳密に円形へ寄せる
            const top = Math.max(0, cy - radius);
            const bottom = Math.min(h, cy + radius);
            this.visionMask.rect(0, 0, w, top).fill({ color: 0x000000, alpha: darkness });
            this.visionMask.rect(0, bottom, w, h - bottom).fill({ color: 0x000000, alpha: darkness });

            for (let y = -radius; y < radius; y += stripeH) {
                const yMid = y + stripeH * 0.5;
                const absY = Math.abs(yMid);
                const dx = Math.sqrt(Math.max(0, radius * radius - absY * absY));
                const rowTop = Math.max(0, cy + y);
                const rowBottom = Math.min(h, cy + y + stripeH);
                const rowHeight = rowBottom - rowTop;
                if (rowHeight <= 0) {
                    continue;
                }

                const leftW = Math.max(0, cx - dx);
                const rightX = Math.min(w, cx + dx);
                const rightW = Math.max(0, w - rightX);

                if (leftW > 0) {
                    this.visionMask.rect(0, rowTop, leftW, rowHeight).fill({ color: 0x000000, alpha: darkness });
                }
                if (rightW > 0) {
                    this.visionMask.rect(rightX, rowTop, rightW, rowHeight).fill({ color: 0x000000, alpha: darkness });
                }
            }

            // 境界を強調して視界外の切り分けを明確化
            this.visionMask.circle(cx, cy, radius).stroke({ color: 0x1f1534, width: 4, alpha: 0.85 });
            this.visionMask.circle(cx, cy, radius - 3).stroke({ color: 0x0c0816, width: 2, alpha: 0.9 });
        }

        this.info.text = [
            `status: ${snapshot.status}`,
            `runners: ${snapshot.runners.length}`,
            ...snapshot.events,
        ].join("\n");
    }

    // --- ワープエフェクト: 外向きに広がるリング + 残像 ---
    private drawWarpEffect(cx: number, cy: number, t: number): void {
        const ECHOES = 3;
        for (let i = ECHOES; i >= 0; i -= 1) {
            const tEcho = Math.max(0, t - i * 0.13);
            const expand = easeOutExpo(tEcho);
            const fade = (1 - easeInQuad(tEcho)) * (i === 0 ? 1 : 0.28 / i);
            if (fade < 0.01) continue;

            this.effects
                .circle(cx, cy, 18 * expand)
                .stroke({ color: 0x4de3ff, width: Math.max(0.5, 3 * (1 - tEcho * 0.6)), alpha: fade * 0.85 });
            this.effects
                .circle(cx, cy, 10 * expand)
                .stroke({ color: 0xb9f6ff, width: Math.max(0.5, 2 * (1 - tEcho * 0.6)), alpha: fade * 0.7 });
        }
    }

    // --- ジャンプエフェクト: スケールアップ三角 + 残像 ---
    private drawJumpEffect(cx: number, cy: number, t: number): void {
        const ECHOES = 3;
        for (let i = ECHOES; i >= 0; i -= 1) {
            const tEcho = Math.max(0, t - i * 0.1);
            const scale = 0.35 + easeOutCubic(tEcho) * 1.5;
            const fade = (1 - easeInQuad(tEcho)) * (i === 0 ? 1 : 0.3 / i);
            if (fade < 0.01) continue;

            const s = 14 * scale;
            this.effects.moveTo(cx - s, cy + s * 0.86);
            this.effects.lineTo(cx, cy - s);
            this.effects.lineTo(cx + s, cy + s * 0.86);
            this.effects.stroke({ color: 0xffd166, width: 2, alpha: fade });
        }
    }

    // --- 斬撃エフェクト: 広がる X 字 + 残像 ---
    private drawCutEffect(cx: number, cy: number, t: number): void {
        const ECHOES = 2;
        for (let i = ECHOES; i >= 0; i -= 1) {
            const tEcho = Math.max(0, t - i * 0.15);
            const scale = 0.3 + easeOutCubic(tEcho) * 1.3;
            const fade = (1 - easeInQuad(tEcho)) * (i === 0 ? 1 : 0.38 / i);
            if (fade < 0.01) continue;

            const s = 18 * scale;
            this.effects.moveTo(cx - s, cy - s * 0.5);
            this.effects.lineTo(cx + s, cy + s * 0.5);
            this.effects.moveTo(cx - s, cy + s * 0.5);
            this.effects.lineTo(cx + s, cy - s * 0.5);
            this.effects.stroke({ color: 0xff6b6b, width: 2.5, alpha: fade });
        }
    }
}
