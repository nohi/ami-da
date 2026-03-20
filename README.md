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

### 環境変数サンプル

`apps/web/.env.example` をコピーして `apps/web/.env` を作成してください。

```bash
cp apps/web/.env.example apps/web/.env
```

## GitHub Pages 公開（`nohi/nohi.github.io` の `/ami-da`）

このリポジトリには `deploy-pages-subdir.yml` があり、`main` への push で  
`nohi/nohi.github.io` の `main` ブランチ配下 `ami-da/` に `apps/web/dist` をデプロイします。

必要な GitHub Secrets（このリポジトリ側）:

- `PAGES_DEPLOY_TOKEN`  
  `nohi/nohi.github.io` へ push できる PAT（`repo` 権限）。
- `VITE_SIGNAL_URL`  
  Cloudflare Workers シグナリングの `wss://...` URL。

補足:

- ビルド時は `VITE_BASE_PATH=/ami-da/` を CI 側で設定しています。
- 既存ファイルを残すため `keep_files: true` でデプロイします。
- Pages 本番では `VITE_WASM_JS_URL` を未設定にしてください（TSフォールバックで動作）。

## Cloudflare Workers シグナリング

`apps/signal` は Cloudflare Workers + Durable Objects で動作します。

```bash
npm run dev -w @amida/signal
```

デプロイ:

```bash
npx wrangler deploy --config apps/signal/wrangler.toml
```

公開URL（`wss://...workers.dev`）を `VITE_SIGNAL_URL` に設定してください。

## 実装メモ

- ホスト判定は Rust/WASM の `validate_skill` を優先利用（未生成時はTSへフォールバック）。
- WASM生成物は `crates/ladder-core/pkg` に出力される（ローカル検証向け）。
- 追加干渉: 透明化、視野妨害。
- 強化演出: ワープ、ジャンプ、線斬り。
