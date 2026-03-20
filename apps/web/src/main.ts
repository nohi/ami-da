import { Application } from "pixi.js";
import type { GuestToHostMessage, HostToGuestMessage, LadderSettings, LadderSnapshot, SkillType } from "@amida/protocol";
import { HostEngine } from "./engine";
import { StarRtc } from "./rtc";
import { makeDefaultSettings, SKILL_LABEL } from "./types";
import { GameView } from "./view";
import { loadWasmCore, type WasmHostDecider } from "./wasmCore";
import "./style.css";

const appRoot = document.querySelector("#app");
if (!appRoot) {
    throw new Error("#app not found");
}

const loadingOverlay = document.createElement("div");
loadingOverlay.className = "loading-screen";
loadingOverlay.innerHTML = `
  <div class="loading-card">
    <div class="loading-spinner" aria-hidden="true"></div>
    <div class="loading-text">読み込み中...</div>
  </div>
`;
appRoot.appendChild(loadingOverlay);

function setLoading(visible: boolean, message = "読み込み中..."): void {
    const textNode = loadingOverlay.querySelector(".loading-text");
    if (textNode) {
        textNode.textContent = message;
    }
    loadingOverlay.style.display = visible ? "flex" : "none";
}

const userId = ensureStableUserId();
let roomId = "";
let selectedSkill: SkillType = "cut_rung";

const roomInput = document.createElement("input");
roomInput.placeholder = "ROOM ID";
const guestNicknameInput = document.createElement("input");
guestNicknameInput.placeholder = "ニックネーム(任意)";

const createBtn = document.createElement("button");
createBtn.textContent = "ルーム作成";
const hostNicknameInput = document.createElement("input");
hostNicknameInput.placeholder = "ホスト名(任意)";
hostNicknameInput.value = defaultNicknameFromUserId(userId);
guestNicknameInput.value = defaultNicknameFromUserId(userId);

const joinBtn = document.createElement("button");
joinBtn.textContent = "参加";
const shareRoomUrlBtn = document.createElement("button");
shareRoomUrlBtn.textContent = "ルームURL共有";
shareRoomUrlBtn.disabled = true;

const startBtn = document.createElement("button");
startBtn.textContent = "抽選スタート";
const restartBtn = document.createElement("button");
restartBtn.textContent = "もう一度抽選";

const applySettingsBtn = document.createElement("button");
applySettingsBtn.textContent = "設定反映";

const statusBadge = document.createElement("span");
statusBadge.className = "badge";
statusBadge.textContent = "未接続";

const roomMemberInfo = document.createElement("div");
roomMemberInfo.className = "warn";
roomMemberInfo.textContent = "参加人数: 0";
const flashMessage = document.createElement("div");
flashMessage.className = "flash-message";
flashMessage.style.display = "none";
const winnerBanner = document.createElement("div");
winnerBanner.className = "winner-banner";
winnerBanner.style.display = "none";
let winnerBannerDismissed = false;
const winnerCloseBtn = document.createElement("button");
winnerCloseBtn.className = "winner-close";
winnerCloseBtn.type = "button";
winnerCloseBtn.setAttribute("aria-label", "抽選結果を閉じる");
winnerCloseBtn.textContent = "×";
const winnerTitle = document.createElement("div");
winnerTitle.className = "winner-title";
winnerTitle.textContent = "🎉 当選結果 🎉";
const winnerNames = document.createElement("div");
winnerNames.className = "winner-names";
winnerBanner.append(winnerCloseBtn, winnerTitle, winnerNames);
winnerCloseBtn.addEventListener("click", () => {
    winnerBannerDismissed = true;
    winnerBanner.style.display = "none";
});

const skillGrid = document.createElement("div");
skillGrid.className = "skill-grid";
const skillButtons = new Map<SkillType, HTMLButtonElement>();
let pendingTargetSkill: "add_rung" | "cut_rung" | "jump" | null = null;

const hostConfig = document.createElement("div");
hostConfig.className = "host-config";

const laneCountInput = document.createElement("input");
laneCountInput.type = "number";
laneCountInput.min = "2";
laneCountInput.max = "12";
laneCountInput.value = "6";

const runnerCountInput = document.createElement("input");
runnerCountInput.type = "number";
runnerCountInput.min = "1";
runnerCountInput.max = "24";
runnerCountInput.value = "1";

const drawNamesInput = document.createElement("textarea");
drawNamesInput.rows = 3;
drawNamesInput.placeholder = "抽選名をカンマ区切りで入力";
drawNamesInput.value = "抽選1,抽選2,抽選3,抽選4,抽選5,抽選6";

const protectedTopInput = document.createElement("input");
protectedTopInput.type = "number";
protectedTopInput.value = "90";

const protectedBottomInput = document.createElement("input");
protectedBottomInput.type = "number";
protectedBottomInput.value = "120";
const allowDuplicateWinnersInput = document.createElement("input");
allowDuplicateWinnersInput.type = "checkbox";
allowDuplicateWinnersInput.checked = false;

const maxAddInput = document.createElement("input");
maxAddInput.type = "number";
maxAddInput.value = "6";
const maxCutInput = document.createElement("input");
maxCutInput.type = "number";
maxCutInput.value = "6";
const maxReverseInput = document.createElement("input");
maxReverseInput.type = "number";
maxReverseInput.value = "3";
const maxSpeedInput = document.createElement("input");
maxSpeedInput.type = "number";
maxSpeedInput.value = "5";
const maxWarpInput = document.createElement("input");
maxWarpInput.type = "number";
maxWarpInput.value = "3";
const maxJumpInput = document.createElement("input");
maxJumpInput.type = "number";
maxJumpInput.value = "4";
const maxCloakInput = document.createElement("input");
maxCloakInput.type = "number";
maxCloakInput.value = "3";
const maxVisionJamInput = document.createElement("input");
maxVisionJamInput.type = "number";
maxVisionJamInput.value = "3";

const cdAddInput = document.createElement("input");
cdAddInput.type = "number";
cdAddInput.value = "1200";
const cdCutInput = document.createElement("input");
cdCutInput.type = "number";
cdCutInput.value = "1400";
const cdReverseInput = document.createElement("input");
cdReverseInput.type = "number";
cdReverseInput.value = "3500";
const cdSpeedInput = document.createElement("input");
cdSpeedInput.type = "number";
cdSpeedInput.value = "2000";
const cdWarpInput = document.createElement("input");
cdWarpInput.type = "number";
cdWarpInput.value = "3000";
const cdJumpInput = document.createElement("input");
cdJumpInput.type = "number";
cdJumpInput.value = "2300";
const cdCloakInput = document.createElement("input");
cdCloakInput.type = "number";
cdCloakInput.value = "3200";
const cdVisionJamInput = document.createElement("input");
cdVisionJamInput.type = "number";
cdVisionJamInput.value = "3800";

const allowAddInput = document.createElement("input");
allowAddInput.type = "checkbox";
allowAddInput.checked = true;
const allowCutInput = document.createElement("input");
allowCutInput.type = "checkbox";
allowCutInput.checked = true;
const allowReverseInput = document.createElement("input");
allowReverseInput.type = "checkbox";
allowReverseInput.checked = true;
const allowSpeedInput = document.createElement("input");
allowSpeedInput.type = "checkbox";
allowSpeedInput.checked = true;
const allowWarpInput = document.createElement("input");
allowWarpInput.type = "checkbox";
allowWarpInput.checked = true;
const allowJumpInput = document.createElement("input");
allowJumpInput.type = "checkbox";
allowJumpInput.checked = true;
const allowCloakInput = document.createElement("input");
allowCloakInput.type = "checkbox";
allowCloakInput.checked = true;
const allowVisionJamInput = document.createElement("input");
allowVisionJamInput.type = "checkbox";
allowVisionJamInput.checked = true;

const overlay = document.createElement("div");
overlay.className = "overlay";
overlay.innerHTML = "<div class='row'><strong>干渉あみだくじ</strong></div>";

const row1 = document.createElement("div");
row1.className = "row";
row1.append(hostNicknameInput, createBtn, shareRoomUrlBtn);

const rowJoin = document.createElement("div");
rowJoin.className = "row";
rowJoin.append(guestNicknameInput, roomInput, joinBtn);

const row2 = document.createElement("div");
row2.className = "row";
row2.append(startBtn, restartBtn, applySettingsBtn);

const rowStatus = document.createElement("div");
rowStatus.className = "row";
rowStatus.append(statusBadge);

const setupSection = document.createElement("div");
setupSection.className = "setup-section";
setupSection.append(row1, rowJoin, rowStatus, row2, hostConfig, roomMemberInfo);

hostConfig.innerHTML = `
  <div class="row"><strong>ホスト設定</strong></div>
  <div class="row compact-row"><label>本数</label></div>
  <div class="row compact-row"><label>当選数(キャラ数)</label></div>
  <div class="row compact-row"><label>抽選名</label></div>
  <div class="row compact-row"><label>禁止距離(上/下)</label></div>
  <div class="row compact-row"><label>重複当選</label></div>
  <div class="row compact-row"><label>スキル設定</label></div>
`;

const hostRows = hostConfig.querySelectorAll(".compact-row");
hostRows[0].append(laneCountInput);
hostRows[1].append(runnerCountInput);
hostRows[2].append(drawNamesInput);
hostRows[3].append(protectedTopInput, protectedBottomInput);
const duplicateLabel = document.createElement("label");
duplicateLabel.className = "toggle";
duplicateLabel.textContent = "有効";
duplicateLabel.prepend(allowDuplicateWinnersInput);
hostRows[4].append(duplicateLabel);
const skillTable = document.createElement("table");
skillTable.className = "skill-table";
skillTable.innerHTML = `
  <thead>
    <tr><th>スキル</th><th>使用可否</th><th>回数上限</th><th>CT(ms)</th></tr>
  </thead>
  <tbody></tbody>
`;
const skillTableBody = skillTable.querySelector("tbody");
if (!skillTableBody) {
    throw new Error("skill table body not found");
}
skillTableBody.append(
    createSkillSettingRow("線追加", allowAddInput, maxAddInput, cdAddInput),
    createSkillSettingRow("線斬り", allowCutInput, maxCutInput, cdCutInput),
    createSkillSettingRow("反転", allowReverseInput, maxReverseInput, cdReverseInput),
    createSkillSettingRow("加速", allowSpeedInput, maxSpeedInput, cdSpeedInput),
    createSkillSettingRow("ワープ", allowWarpInput, maxWarpInput, cdWarpInput),
    createSkillSettingRow("ジャンプ", allowJumpInput, maxJumpInput, cdJumpInput),
    createSkillSettingRow("透明化", allowCloakInput, maxCloakInput, cdCloakInput),
    createSkillSettingRow("視野妨害", allowVisionJamInput, maxVisionJamInput, cdVisionJamInput),
);
hostRows[5].append(skillTable);

overlay.append(setupSection, skillGrid);
appRoot.append(overlay, flashMessage, winnerBanner);

let hostEngine = new HostEngine(makeDefaultSettings(6));
let wasmDecider: WasmHostDecider | null = await loadWasmCore();
hostEngine.setDecider(wasmDecider);

let app: Application | null = null;
let gameView: Pick<GameView, "render"> = { render: () => undefined };
let pendingApp: Application | null = null;
let rendererBound = false;
function bindRendererEvents(rendererApp: Application): void {
    if (rendererBound) {
        return;
    }
    rendererBound = true;
    rendererApp.canvas.addEventListener("click", (ev) => {
        if (pendingTargetSkill === null || latestSnapshot.status !== "running") {
            return;
        }
        const targeted = buildTargetedProposalFromClick(ev.clientX, ev.clientY, pendingTargetSkill);
        pendingTargetSkill = null;
        if (!targeted) {
            statusBadge.textContent = "対象を選択できませんでした";
            return;
        }
        sendProposal(targeted);
    });
}
function attachRenderer(rendererApp: Application): void {
    if (app === rendererApp) {
        return;
    }
    app = rendererApp;
    appRoot?.appendChild(rendererApp.canvas);
    gameView = new GameView(rendererApp);
    bindRendererEvents(rendererApp);
}
try {
    pendingApp = new Application();
    const initPromise = pendingApp.init({
        resizeTo: window,
        antialias: true,
        backgroundAlpha: 0,
        autoDensity: true,
    });
    const initTimeoutMs = 5000;
    const initResult = await Promise.race([
        initPromise.then(() => "ready" as const),
        new Promise<"timeout">((resolve) => {
            window.setTimeout(() => resolve("timeout"), initTimeoutMs);
        }),
    ]);
    if (initResult === "ready") {
        attachRenderer(pendingApp);
        pendingApp = null;
    } else {
        const delayedApp = pendingApp;
        statusBadge.textContent = "描画初期化待機中: ルーム機能のみ利用可能";
        void initPromise
            .then(() => {
                if (delayedApp) {
                    attachRenderer(delayedApp);
                    statusBadge.textContent = "描画初期化完了";
                }
                pendingApp = null;
            })
            .catch((err) => {
                console.error("renderer init failed", err);
                statusBadge.textContent = "描画初期化失敗: ルーム機能のみ利用可能";
                pendingApp = null;
            });
    }
} catch (err) {
    app = null;
    pendingApp = null;
    console.error("renderer init failed", err);
    statusBadge.textContent = "描画初期化失敗: ルーム機能のみ利用可能";
}
let latestSnapshot: LadderSnapshot = {
    status: "waiting",
    serverTimeMs: Date.now(),
    settings: makeDefaultSettings(6),
    rungs: [],
    runners: [],
    effects: [],
    skillStateByUserId: {},
    playerNicknamesByUserId: {},
    visionJammedUntilMsByUserId: {},
    events: [],
};
let guestRenderSnapshot: LadderSnapshot | null = null;

let rtc = new StarRtc(userId, {
    onGuestMessage: (fromUserId, msg) => {
        if (!rtc.isHost()) {
            return;
        }
        if (msg.kind === "request_snapshot") {
            hostEngine.registerPlayer(fromUserId, msg.fromNickname);
            rtc.sendToPeer(fromUserId, { kind: "snapshot", snapshot: hostEngine.update(Date.now(), 0) });
            return;
        }
        const reply = hostEngine.onGuestMessage(msg, Date.now());
        applyHostReply(reply);
    },
    onHostMessage: (msg) => {
        applyHostReply(msg);
    },
    onPeerJoined: (uid) => {
        if (!rtc.isHost()) {
            return;
        }
        hostEngine.registerPlayer(uid);
        broadcastSnapshot();
    },
    onPeerLeft: (uid) => {
        if (rtc.isHost()) {
            hostEngine.unregisterPlayer(uid);
            broadcastSnapshot();
        }
        statusBadge.textContent = "参加者離脱";
    },
    onPeerChannelOpen: (uid) => {
        if (rtc.isHost()) {
            rtc.sendToPeer(uid, { kind: "snapshot", snapshot: hostEngine.update(Date.now(), 0) });
            return;
        }
        rtc.sendToHost({
            kind: "request_snapshot",
            fromUserId: userId,
            fromNickname: resolveNickname(guestNicknameInput.value),
            clientTimeMs: Date.now(),
        });
    },
});
updateRoleUi();

createBtn.onclick = async () => {
    setLoading(true, "ルーム作成中...");
    try {
        const settings = buildSettingsFromUi();
        hostEngine = new HostEngine(settings, wasmDecider);
        hostEngine.registerPlayer(userId, resolveNickname(hostNicknameInput.value));
        roomId = await rtc.createRoom();
        roomInput.value = roomId;
        statusBadge.textContent = `ルーム作成: ${roomId}`;
        latestSnapshot = hostEngine.update(Date.now(), 0);
        gameView.render(latestSnapshot, userId);
        updateRoleUi();
    } catch (err) {
        console.error("create room failed", err);
        statusBadge.textContent = `作成失敗: ${String(err)}`;
    } finally {
        setLoading(false);
    }
};

async function joinCurrentRoom(): Promise<void> {
    setLoading(true, "ルーム参加中...");
    roomId = roomInput.value.trim().toUpperCase();
    if (!roomId) {
        statusBadge.textContent = "ROOM ID必須";
        setLoading(false);
        return;
    }
    try {
        await rtc.joinRoom(roomId);
        statusBadge.textContent = `参加済み: ${roomId}`;
        rtc.sendToHost({
            kind: "request_snapshot",
            fromUserId: userId,
            fromNickname: resolveNickname(guestNicknameInput.value),
            clientTimeMs: Date.now(),
        });
        updateRoleUi();
    } catch (err) {
        console.error("join room failed", err);
        statusBadge.textContent = `参加失敗: ${describeJoinError(err)}`;
    } finally {
        setLoading(false);
    }
}

joinBtn.onclick = () => {
    void joinCurrentRoom();
};
let flashTimerId: number | null = null;
shareRoomUrlBtn.onclick = async () => {
    if (!canControlHost() || roomId.length === 0) {
        return;
    }
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("room", roomId);
    try {
        await navigator.clipboard.writeText(shareUrl.toString());
        flashMessage.textContent = "共有URLをコピーしました";
        flashMessage.style.display = "block";
        if (flashTimerId !== null) {
            window.clearTimeout(flashTimerId);
        }
        flashTimerId = window.setTimeout(() => {
            flashMessage.style.display = "none";
            flashTimerId = null;
        }, 2000);
    } catch (err) {
        console.error("share url copy failed", err);
        statusBadge.textContent = "共有URLコピーに失敗しました";
    }
};

startBtn.onclick = () => {
    if (!canControlHost()) {
        statusBadge.textContent = "ホストのみ開始可";
        return;
    }
    hostEngine.start();
    broadcastSnapshot();
    updateOverlayByGameState();
};

restartBtn.onclick = () => {
    if (!canControlHost()) {
        statusBadge.textContent = "ホストのみ再抽選可";
        return;
    }
    if (latestSnapshot.status !== "finished") {
        statusBadge.textContent = "終了後に再抽選できます";
        return;
    }
    hostEngine.restartRound();
    latestSnapshot = hostEngine.update(Date.now(), 0);
    winnerBannerDismissed = false;
    winnerBanner.style.display = "none";
    statusBadge.textContent = "再抽選準備完了";
    broadcastSnapshot();
    updateOverlayByGameState();
};

applySettingsBtn.onclick = () => {
    if (!canControlHost()) {
        statusBadge.textContent = "ホストのみ設定可";
        return;
    }
    if (latestSnapshot.status !== "waiting") {
        statusBadge.textContent = "進行中は変更不可";
        return;
    }

    const settings = buildSettingsFromUi();
    hostEngine = new HostEngine(settings, wasmDecider);
    hostEngine.registerPlayer(userId, resolveNickname(hostNicknameInput.value));
    latestSnapshot = hostEngine.update(Date.now(), 0);
    broadcastSnapshot();
    statusBadge.textContent = "設定反映完了";
};

const skills: SkillType[] = ["add_rung", "cut_rung", "reverse", "speed_boost", "warp", "jump", "cloak", "vision_jam"];
for (const skill of skills) {
    const b = document.createElement("button");
    b.textContent = SKILL_LABEL[skill];
    b.className = "skill-btn";
    b.onclick = () => {
        selectedSkill = skill;
        if (skill === "add_rung" || skill === "cut_rung" || skill === "jump") {
            pendingTargetSkill = skill;
            statusBadge.textContent = skill === "jump"
                ? `${SKILL_LABEL[skill]}: 対象ランナーをクリック`
                : `${SKILL_LABEL[skill]}: 位置をクリック`;
            return;
        }
        statusBadge.textContent = `発動: ${SKILL_LABEL[skill]}`;
        castSelectedSkill();
    };
    skillButtons.set(skill, b);
    skillGrid.append(b);
}

window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Space") {
        return;
    }
    castSelectedSkill();
});

let lastFrameMs = performance.now();
let lastSnapshotBroadcastMs = 0;
const tick = () => {
    const now = performance.now();
    const dtSec = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    const prevStatus = latestSnapshot.status;

    if (rtc.isHost()) {
        latestSnapshot = hostEngine.update(Date.now(), dtSec);
        if (now - lastSnapshotBroadcastMs >= 120) {
            lastSnapshotBroadcastMs = now;
            broadcastSnapshot();
        }
    }

    if (latestSnapshot.status !== prevStatus) {
        updateOverlayByGameState();
    }

    const renderSnapshot = rtc.isHost()
        ? latestSnapshot
        : interpolateGuestSnapshot(guestRenderSnapshot, latestSnapshot, dtSec);
    if (!rtc.isHost()) {
        guestRenderSnapshot = renderSnapshot;
    }
    gameView.render(renderSnapshot, userId);
    updateSkillButtonsUi();
};

window.setInterval(tick, 1000 / 30);

function applyHostReply(msg: HostToGuestMessage): void {
    if (msg.kind === "snapshot") {
        latestSnapshot = msg.snapshot;
        if (!rtc.isHost() && guestRenderSnapshot && guestRenderSnapshot.status !== latestSnapshot.status) {
            guestRenderSnapshot = null;
        }
        updateOverlayByGameState();
        updateSkillButtonsUi();
        return;
    }
    if (msg.kind === "skill_accept") {
        latestSnapshot = msg.snapshot;
        if (!rtc.isHost() && guestRenderSnapshot && guestRenderSnapshot.status !== latestSnapshot.status) {
            guestRenderSnapshot = null;
        }
        statusBadge.textContent = "干渉成功";
        updateOverlayByGameState();
        updateSkillButtonsUi();
        if (rtc.isHost()) {
            rtc.broadcast(msg);
        }
        return;
    }
    if (msg.kind === "skill_reject") {
        statusBadge.textContent = `拒否: ${msg.reason}`;
        if (rtc.isHost()) {
            rtc.broadcast(msg);
        }
        return;
    }
    if (msg.kind === "result") {
        latestSnapshot = msg.snapshot;
        if (!rtc.isHost() && guestRenderSnapshot && guestRenderSnapshot.status !== latestSnapshot.status) {
            guestRenderSnapshot = null;
        }
        updateOverlayByGameState();
        updateSkillButtonsUi();
    }
}

function broadcastSnapshot(): void {
    const snap = hostEngine.update(Date.now(), 0);
    latestSnapshot = snap;
    updateOverlayByGameState();
    updateSkillButtonsUi();
    rtc.broadcast({ kind: "snapshot", snapshot: snap });
}

function buildSettingsFromUi(): LadderSettings {
    const laneCount = clamp(readInt(laneCountInput.value, 6), 2, 12);
    const runnerCount = clamp(readInt(runnerCountInput.value, 1), 1, 24);
    const names = drawNamesInput.value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

    const drawNames = Array.from({ length: laneCount }, (_, i) => names[i] ?? `抽選${i + 1}`);

    const allowedSkills: SkillType[] = [];
    if (allowAddInput.checked) {
        allowedSkills.push("add_rung");
    }
    if (allowCutInput.checked) {
        allowedSkills.push("cut_rung");
    }
    if (allowReverseInput.checked) {
        allowedSkills.push("reverse");
    }
    if (allowSpeedInput.checked) {
        allowedSkills.push("speed_boost");
    }
    if (allowWarpInput.checked) {
        allowedSkills.push("warp");
    }
    if (allowJumpInput.checked) {
        allowedSkills.push("jump");
    }
    if (allowCloakInput.checked) {
        allowedSkills.push("cloak");
    }
    if (allowVisionJamInput.checked) {
        allowedSkills.push("vision_jam");
    }

    if (allowedSkills.length === 0) {
        allowedSkills.push("cut_rung");
    }

    return {
        laneCount,
        runnerCount,
        totalHeight: 2200,
        seed: (Math.random() * 1_000_000) | 0,
        drawNames,
        rules: {
            allowedSkills,
            maxUsePerSkill: {
                add_rung: clamp(readInt(maxAddInput.value, 6), 0, 99),
                cut_rung: clamp(readInt(maxCutInput.value, 6), 0, 99),
                reverse: clamp(readInt(maxReverseInput.value, 3), 0, 99),
                speed_boost: clamp(readInt(maxSpeedInput.value, 5), 0, 99),
                warp: clamp(readInt(maxWarpInput.value, 3), 0, 99),
                jump: clamp(readInt(maxJumpInput.value, 4), 0, 99),
                cloak: clamp(readInt(maxCloakInput.value, 3), 0, 99),
                vision_jam: clamp(readInt(maxVisionJamInput.value, 3), 0, 99),
            },
            cooldownMs: {
                add_rung: clamp(readInt(cdAddInput.value, 1200), 0, 60_000),
                cut_rung: clamp(readInt(cdCutInput.value, 1400), 0, 60_000),
                reverse: clamp(readInt(cdReverseInput.value, 3500), 0, 60_000),
                speed_boost: clamp(readInt(cdSpeedInput.value, 2000), 0, 60_000),
                warp: clamp(readInt(cdWarpInput.value, 3000), 0, 60_000),
                jump: clamp(readInt(cdJumpInput.value, 2300), 0, 60_000),
                cloak: clamp(readInt(cdCloakInput.value, 3200), 0, 60_000),
                vision_jam: clamp(readInt(cdVisionJamInput.value, 3800), 0, 60_000),
            },
            protectedTopDistance: clamp(readInt(protectedTopInput.value, 90), 0, 1000),
            protectedBottomDistance: clamp(readInt(protectedBottomInput.value, 120), 0, 1000),
            allowDuplicateWinners: allowDuplicateWinnersInput.checked,
        },
    };
}

function readInt(raw: string, fallback: number): number {
    const v = Number.parseInt(raw, 10);
    if (Number.isNaN(v)) {
        return fallback;
    }
    return v;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function createSkillSettingRow(
    label: string,
    allowInput: HTMLInputElement,
    maxInput: HTMLInputElement,
    cdInput: HTMLInputElement,
): HTMLTableRowElement {
    const tr = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = label;

    const allowCell = document.createElement("td");
    allowCell.className = "skill-cell-center";
    allowCell.append(allowInput);

    const maxCell = document.createElement("td");
    maxCell.className = "skill-cell-center";
    maxCell.append(maxInput);

    const cdCell = document.createElement("td");
    cdCell.className = "skill-cell-center";
    cdCell.append(cdInput);

    tr.append(nameCell, allowCell, maxCell, cdCell);
    return tr;
}

function canControlHost(): boolean {
    return roomId.length > 0 && rtc.isHost();
}

function updateRoleUi(): void {
    const hostReady = roomId.length > 0 && rtc.isHost();
    const showSkills = roomId.length > 0 && latestSnapshot.status === "running";
    const guestJoined = roomId.length > 0 && !rtc.isHost();
    const guestCanEditNickname = guestJoined && latestSnapshot.status === "waiting";

    // 初期表示から「作成」「ROOM ID入力」「参加」を同時表示
    createBtn.style.display = "inline-block";
    roomInput.style.display = "inline-block";
    joinBtn.style.display = "inline-block";
    shareRoomUrlBtn.style.display = "inline-block";
    shareRoomUrlBtn.disabled = !hostReady;

    // ホスト設定はホストがルーム作成完了後にのみ表示
    row2.style.display = hostReady ? "flex" : "none";
    hostConfig.style.display = hostReady ? "block" : "none";
    applySettingsBtn.style.display = hostReady ? "inline-block" : "none";
    startBtn.style.display = hostReady && latestSnapshot.status !== "running" ? "inline-block" : "none";
    restartBtn.style.display = hostReady && latestSnapshot.status === "finished" ? "inline-block" : "none";

    // スキル操作は抽選開始後のみ表示
    skillGrid.style.display = showSkills ? "grid" : "none";
    hostNicknameInput.disabled = roomId.length > 0;
    guestNicknameInput.disabled = rtc.isHost() || (guestJoined && !guestCanEditNickname);
}

function updateOverlayByGameState(): void {
    if (latestSnapshot.status === "running") {
        overlay.classList.add("running");
    } else {
        overlay.classList.remove("running");
    }
    if (latestSnapshot.status === "finished") {
        if (!winnerBannerDismissed) {
            showWinnerBanner();
        }
    } else {
        winnerBannerDismissed = false;
        winnerBanner.style.display = "none";
    }
    updateRoleUi();
    updateRoomMemberInfo();
}

function ensureStableUserId(): string {
    const key = "amida-user-id";
    const cached = sessionStorage.getItem(key);
    if (cached) {
        return cached;
    }
    const created = `u-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, created);
    return created;
}

function castSelectedSkill(): void {
    if (latestSnapshot.status !== "running") {
        return;
    }
    if (selectedSkill === "jump") {
        pendingTargetSkill = "jump";
        statusBadge.textContent = `${SKILL_LABEL.jump}: 対象ランナーをクリック`;
        return;
    }
    const target = latestSnapshot.runners.find((r) => !r.finished) ?? latestSnapshot.runners[0];
    if (!target) {
        statusBadge.textContent = "対象ランナー不在";
        return;
    }

    const lane = Math.round(target.lane);
    const proposal: GuestToHostMessage = {
        kind: "skill_proposal",
        proposalId: crypto.randomUUID(),
        fromUserId: userId,
        fromNickname: resolveNickname(rtc.isHost() ? hostNicknameInput.value : guestNicknameInput.value),
        targetUserId: target.userId,
        skill: selectedSkill,
        payload: {
            y: selectedSkill === "warp" ? target.y + 80 : target.y,
            laneLeft:
                selectedSkill === "warp"
                        ? (lane + 1) % latestSnapshot.settings.laneCount
                        : Math.max(0, lane - 1),
            durationMs:
                selectedSkill === "reverse"
                    ? 2200
                    : selectedSkill === "cloak"
                        ? 2600
                        : selectedSkill === "vision_jam"
                            ? 2800
                            : 1600,
        },
        clientTimeMs: Date.now(),
    };

    sendProposal(proposal);
}

function sendProposal(proposal: GuestToHostMessage): void {
    if (rtc.isHost()) {
        const reply = hostEngine.onGuestMessage(proposal, Date.now());
        applyHostReply(reply);
    } else {
        rtc.sendToHost(proposal);
        statusBadge.textContent = `送信: ${SKILL_LABEL[selectedSkill]}`;
    }
}

function buildTargetedProposalFromClick(
    clientX: number,
    clientY: number,
    skill: "add_rung" | "cut_rung" | "jump",
): GuestToHostMessage | null {
    const rendererApp = app;
    if (!rendererApp) {
        return null;
    }
    const w = rendererApp.screen.width;
    const h = rendererApp.screen.height;
    const skillBarReserve = latestSnapshot.status === "running" ? 98 : 0;
    const bottomY = h - 30 - skillBarReserve;
    const marginX = 70;
    const laneGap = (w - marginX * 2) / Math.max(1, latestSnapshot.settings.laneCount - 1);
    const yScale = (bottomY - 40) / latestSnapshot.settings.totalHeight;
    const rect = rendererApp.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * w;
    const y = ((clientY - rect.top) / rect.height) * h;
    const worldY = clamp((y - 40) / yScale, 0, latestSnapshot.settings.totalHeight);
    const defaultTarget = latestSnapshot.runners.find((r) => !r.finished) ?? latestSnapshot.runners[0];
    if (!defaultTarget) {
        return null;
    }
    const target = skill === "jump"
        ? pickRunnerFromCanvasPoint(x, y, marginX, laneGap, yScale) ?? defaultTarget
        : defaultTarget;
    if (!target) {
        return null;
    }

    if (skill === "add_rung") {
        const laneFloat = (x - marginX) / laneGap;
        const laneLeft = clamp(Math.floor(laneFloat), 0, latestSnapshot.settings.laneCount - 2);
        return {
            kind: "skill_proposal",
            proposalId: crypto.randomUUID(),
            fromUserId: userId,
            fromNickname: resolveNickname(rtc.isHost() ? hostNicknameInput.value : guestNicknameInput.value),
            targetUserId: target.userId,
            skill: "add_rung",
            payload: { laneLeft, y: worldY },
            clientTimeMs: Date.now(),
        };
    }

    if (skill === "jump") {
        const lane = Math.round(target.lane);
        return {
            kind: "skill_proposal",
            proposalId: crypto.randomUUID(),
            fromUserId: userId,
            fromNickname: resolveNickname(rtc.isHost() ? hostNicknameInput.value : guestNicknameInput.value),
            targetUserId: target.userId,
            skill: "jump",
            payload: {
                laneLeft: lane + 2,
                y: target.y + 45,
                durationMs: 1600,
            },
            clientTimeMs: Date.now(),
        };
    }

    const activeRungs = latestSnapshot.rungs.filter((r) => r.active);
    if (activeRungs.length === 0) {
        return null;
    }
    const nearest = activeRungs
        .map((r) => {
            const rx = marginX + (r.laneLeft + 0.5) * laneGap;
            const ry = 40 + r.y * yScale;
            const d2 = (rx - x) ** 2 + (ry - y) ** 2;
            return { rung: r, d2 };
        })
        .sort((a, b) => a.d2 - b.d2)[0];
    if (!nearest || nearest.d2 > 38 * 38) {
        return null;
    }
    return {
        kind: "skill_proposal",
        proposalId: crypto.randomUUID(),
        fromUserId: userId,
        fromNickname: resolveNickname(rtc.isHost() ? hostNicknameInput.value : guestNicknameInput.value),
        targetUserId: target.userId,
        skill: "cut_rung",
        payload: { rungId: nearest.rung.id },
        clientTimeMs: Date.now(),
    };
}

function pickRunnerFromCanvasPoint(
    x: number,
    y: number,
    marginX: number,
    laneGap: number,
    yScale: number,
): LadderSnapshot["runners"][number] | null {
    const candidates = latestSnapshot.runners.filter((r) => !r.finished);
    if (candidates.length === 0) {
        return null;
    }
    const nearest = candidates
        .map((r) => {
            const rx = marginX + r.lane * laneGap;
            const ry = 40 + r.y * yScale;
            const d2 = (rx - x) ** 2 + (ry - y) ** 2;
            return { runner: r, d2 };
        })
        .sort((a, b) => a.d2 - b.d2)[0];
    if (!nearest || nearest.d2 > 28 * 28) {
        return null;
    }
    return nearest.runner;
}

function updateSkillButtonsUi(): void {
    const now = latestSnapshot.serverTimeMs;
    const myState = latestSnapshot.skillStateByUserId[userId];
    for (const skill of skills) {
        const button = skillButtons.get(skill);
        if (!button) {
            continue;
        }
        const maxUse = latestSnapshot.settings.rules.maxUsePerSkill[skill];
        const cooldownMs = latestSnapshot.settings.rules.cooldownMs[skill];
        const used = myState?.usage[skill] ?? 0;
        const remain = Math.max(0, maxUse - used);
        const lastUseMs = myState?.lastUseMs[skill] ?? 0;
        const elapsed = now - lastUseMs;
        const cdRemain = Math.max(0, cooldownMs - elapsed);
        const cdRatio = cooldownMs > 0 ? Math.max(0, Math.min(1, cdRemain / cooldownMs)) : 0;
        const allowed = latestSnapshot.settings.rules.allowedSkills.includes(skill);
        const exhausted = remain <= 0;
        const onCooldown = cdRemain > 0;
        const waitingForClick = pendingTargetSkill === skill;
        const disabled = latestSnapshot.status !== "running" || !allowed || exhausted || onCooldown;
        button.disabled = disabled;
        button.textContent = waitingForClick ? `${SKILL_LABEL[skill]}: クリック待ち` : `${SKILL_LABEL[skill]} (${remain})`;

        const pct = Math.round(cdRatio * 100);
        if (cdRatio > 0) {
            button.style.background = `linear-gradient(90deg, rgb(248 91 91 / 78%) ${pct}%, rgb(255 255 255 / 10%) ${pct}%)`;
        } else {
            button.style.background = "";
        }
        button.classList.toggle("skill-btn-cd", cdRatio > 0);
        button.classList.toggle("skill-btn-empty", exhausted);
        button.title = onCooldown ? `CT: ${Math.ceil(cdRemain / 100) / 10}s` : `残り回数: ${remain}`;
    }
}

function showWinnerBanner(): void {
    const winners = latestSnapshot.runners
        .map((r) => {
            const lane = Math.round(r.resultLane ?? r.lane);
            const drawName = latestSnapshot.settings.drawNames[lane] ?? `抽選${lane + 1}`;
            return { name: drawName, lane };
        })
        .sort((a, b) => a.lane - b.lane)
        .slice(0, Math.max(1, latestSnapshot.settings.runnerCount));
    const names = winners.map((w) => w.name).join(" / ");
    winnerNames.textContent = names;
    winnerBanner.style.display = "block";
}

function updateRoomMemberInfo(): void {
    if (!roomId || !latestSnapshot) {
        roomMemberInfo.textContent = "参加人数: 0";
        return;
    }
    const names = Object.entries(latestSnapshot.playerNicknamesByUserId ?? {})
        .map(([uid, nick]) => {
            const trimmed = nick.trim();
            return trimmed.length > 0 ? trimmed : defaultNicknameFromUserId(uid);
        })
        .sort((a, b) => a.localeCompare(b, "ja"));
    roomMemberInfo.textContent = names.length > 0
        ? `参加人数: ${names.length} (${names.join(", ")})`
        : "参加人数: 0";
}

function hashText(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function defaultNicknameFromUserId(uid: string): string {
    const colors = ["赤", "青", "緑", "黄", "紫", "橙", "桃", "白", "黒", "銀"];
    const animals = ["ねこ", "いぬ", "うさぎ", "きつね", "たぬき", "りす", "くま", "ひつじ", "ぺんぎん", "ふくろう"];
    const hash = hashText(uid);
    const color = colors[hash % colors.length];
    const animal = animals[Math.floor(hash / colors.length) % animals.length];
    return `${color}${animal}`;
}

function resolveNickname(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : defaultNicknameFromUserId(userId);
}

function describeJoinError(err: unknown): string {
    const text = String(err);
    if (text.includes("room not found")) {
        return "ルームが見つかりません（ID誤り・期限切れ・ホスト離脱の可能性）";
    }
    if (text.includes("room expired")) {
        return "ルームの有効期限が切れました（ホスト接続が一定時間失われました）";
    }
    if (text.includes("target not found")) {
        return "接続先が見つかりません（ホスト再接続中の可能性）";
    }
    if (text.includes("host offline")) {
        return "ホストが再接続中です。数秒待って再試行してください";
    }
    if (text.includes("timed out waiting signaling response")) {
        return "シグナリング応答タイムアウト（通信遅延）";
    }
    if (text.includes("timed out waiting signaling connection")) {
        return "シグナリング接続タイムアウト（ネットワーク不通）";
    }
    if (text.includes("failed to connect signaling socket")) {
        return "シグナリングサーバーへ接続できません";
    }
    if (text.includes("signaling socket closed")) {
        return "シグナリング接続が切断されました";
    }
    if (text.includes("timed out waiting host data channel")) {
        return "ホストとのP2P接続確立がタイムアウトしました（NAT/通信制限・ブラウザ差異の可能性）";
    }
    return `不明なエラー: ${text}`;
}

function interpolateGuestSnapshot(
    previous: LadderSnapshot | null,
    target: LadderSnapshot,
    dtSec: number,
): LadderSnapshot {
    if (!previous || previous.status !== target.status || previous.runners.length !== target.runners.length) {
        return cloneSnapshotForRender(target);
    }
    const prevByUserId = new Map(previous.runners.map((r) => [r.userId, r]));
    const alpha = 1 - Math.exp(-dtSec * 12);
    return {
        ...target,
        runners: target.runners.map((runner) => {
            const prev = prevByUserId.get(runner.userId);
            if (!prev || runner.finished) {
                return { ...runner };
            }
            return {
                ...runner,
                lane: lerp(prev.lane, runner.lane, alpha),
                y: lerp(prev.y, runner.y, alpha),
                speed: lerp(prev.speed, runner.speed, alpha),
            };
        }),
    };
}

function cloneSnapshotForRender(snapshot: LadderSnapshot): LadderSnapshot {
    return {
        ...snapshot,
        runners: snapshot.runners.map((r) => ({ ...r })),
        rungs: snapshot.rungs.map((r) => ({ ...r })),
        effects: snapshot.effects.map((e) => ({ ...e })),
    };
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function sendGuestNicknameUpdate(): void {
    if (rtc.isHost() || !roomId || latestSnapshot.status !== "waiting") {
        return;
    }
    rtc.sendToHost({
        kind: "request_snapshot",
        fromUserId: userId,
        fromNickname: resolveNickname(guestNicknameInput.value),
        clientTimeMs: Date.now(),
    });
}

guestNicknameInput.addEventListener("change", sendGuestNicknameUpdate);
guestNicknameInput.addEventListener("blur", sendGuestNicknameUpdate);
guestNicknameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
        sendGuestNicknameUpdate();
    }
});

const roomParam = new URLSearchParams(window.location.search).get("room");
if (roomParam && roomParam.trim().length > 0) {
    roomInput.value = roomParam.trim().toUpperCase();
    void joinCurrentRoom();
} else {
    setLoading(false);
}
