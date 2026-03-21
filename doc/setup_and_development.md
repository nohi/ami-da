# セットアップ

```bash
npm install
npm run dev
```

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
