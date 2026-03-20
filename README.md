# 多人数干渉型あみだくじ (WIP)

Rust/WASMコア + WebRTC + Pixi.js を前提にした、ホスト権威型の多人数干渉あみだくじです。

## 現在の実装ステータス

- Phase 1 開始
- MVPスキル実装済み:
  - 線追加
  - 線斬り
  - 進行方向反転
  - スピードアップ
  - ワープ
  - ジャンプ
  - 透明化
  - 視野妨害
- ホスト権威同期:
  - ゲストは Proposal を送信
  - ホストで検証し Accept / Reject を全体配信
  - WASMデシジョン連携（利用不可時はTSフォールバック）

## セットアップ

```bash
npm install
npm run build:wasm
npm run dev
```

- Web: http://localhost:5173
- Signaling: ws://localhost:8787

## 実装メモ

- ホスト判定は Rust/WASM の `validate_skill` を優先利用（未生成時はTSへフォールバック）。
- WASM生成物は `crates/ladder-core/pkg` に出力される。
- 追加干渉: 透明化、視野妨害。
- 強化演出: ワープ、ジャンプ、線斬り。
