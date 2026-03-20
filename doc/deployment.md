# デプロイ手順（GitHub Pages + Cloudflare Workers）

本プロジェクトの本番構成は以下です。

- Web配信: `https://nohi.github.io/ami-da/`（GitHub Pages）
- シグナリング: Cloudflare Workers + Durable Objects

## 1. 事前準備

### 1-1. 必要アカウント

- GitHub（`nohi/ami-da`, `nohi/nohi.github.io` にアクセス可能）
- Cloudflare（Workers 利用可能）

### 1-2. ローカルセットアップ

```bash
npm install
```

## 2. Cloudflare Workers（シグナリング）デプロイ

### 2-1. ログイン

```bash
npx wrangler login
```

### 2-2. デプロイ実行

```bash
npx wrangler deploy --config apps/signal/wrangler.toml
```

成功すると `https://<worker-name>.<subdomain>.workers.dev` が表示されます。  
この URL を Web 側の `VITE_SIGNAL_URL` として使います（WebSocket は `wss://`）。

例:

- HTTPS: `https://amida-signal.nohi.workers.dev`
- WSS: `wss://amida-signal.nohi.workers.dev`

### 2-3. ヘルスチェック

```bash
curl https://amida-signal.nohi.workers.dev/healthz
```

`ok` が返れば正常です。

## 3. GitHub Pages（Web）デプロイ

### 3-1. GitHub Secrets 設定（`nohi/ami-da` 側）

- `VITE_SIGNAL_URL` = `wss://<your-worker>.workers.dev`
- `PAGES_DEPLOY_TOKEN` = `nohi/nohi.github.io` に push できる PAT

### 3-2. CI でデプロイ（推奨）

`main` に push すると `.github/workflows/deploy-pages-subdir.yml` が実行され、  
`nohi/nohi.github.io` の `ami-da/` へ配備されます。

確認先:

- Actions: `https://github.com/nohi/ami-da/actions`
- 公開URL: `https://nohi.github.io/ami-da/`

## 4. 手動デプロイ（緊急時）

CI の Secrets 未設定などで止まる場合の手動反映手順です。

### 4-1. 本番ビルド

PowerShell:

```powershell
$env:VITE_BASE_PATH='/ami-da/'
$env:VITE_SIGNAL_URL='wss://<your-worker>.workers.dev'
npm run build -w @amida/web
```

### 4-2. `nohi.github.io` へ同期

1. `nohi/nohi.github.io` を clone
2. `apps/web/dist` の内容を `ami-da/` へ上書き
3. commit & push

## 5. 動作確認チェックリスト

- `https://nohi.github.io/ami-da/` が表示される
- ルーム作成が成功する
- 別ブラウザからルーム参加できる
- 抽選開始、スキル使用、再抽選が動作する
- ブラウザコンソールに `VITE_SIGNAL_URL is required` や WebSocket 接続エラーがない

## 6. トラブルシュート

- Pages が古い表示のまま
  - 数分待つ（CDN反映遅延）
  - ハードリロード（`Ctrl+F5`）
- ルーム作成/参加が失敗
  - `VITE_SIGNAL_URL` が正しいか確認
  - Worker の `/healthz` が `ok` か確認
  - `wss://` を使っているか確認
- Actions 失敗: `not found deploy key or tokens`
  - `PAGES_DEPLOY_TOKEN` 未設定/権限不足
