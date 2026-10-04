# Blog API と移行

本番ブログは `https://blog.app.nagutabby.uk` で配信します。静的ファイルは非公開 S3 と CloudFront、Hono API は Lambda と API Gateway、Follower と RelayConnection は DynamoDB で動作します。AWS リソースは [`infra/`](../infra/README.md) の CDK で管理します。

## API

- ActivityPub: `/.well-known/webfinger`、`/.well-known/nodeinfo`、`/nodeinfo/2.0`、`/nodeinfo/2.1`、`/actor` 以下、および `/api/articles/{id}`
- お問い合わせ: `POST /rpc/contact/submit`
- 記事公開通知: `POST /rpc/federation-admin/publish-article-activity`。`Authorization: Bearer <FEDERATION_ADMIN_TOKEN>` が必要です。
- `/actor/inbox` への POST は CloudFront Function が 403 を返します。API Gateway を直接呼んだ場合も CloudFront 用の秘密ヘッダーがないため 403 になります。

記事通知のリクエスト形式は次のとおりです。外部の公開処理から呼ぶ場合は、新しいホスト名と Secrets Manager の `FEDERATION_ADMIN_TOKEN` を設定してください。

```sh
curl -X POST https://blog.app.nagutabby.uk/rpc/federation-admin/publish-article-activity \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $FEDERATION_ADMIN_TOKEN" \
  -d '{"articleId":"goodbye-microcms","changeType":"create"}'
```

`changeType` には `create`、`update`、`delete` を指定します。

## ローカル開発

ローカルの Hono API テストには Wrangler とローカル D1 アダプターを使います。これは開発用シミュレーターで、本番 Worker やリモート D1 はありません。`backend/wrangler.jsonc` に本番ホストの route は設定しません。

```sh
pnpm --dir web install
pnpm --dir web run dev:worker
```

Worker は `http://localhost:8787` で起動します。ローカル D1 のスキーマはリポジトリルートで `make db-migrate` を実行して適用します。Astro は別ターミナルで `pnpm --dir web run dev` を実行します。

## AWS への初回デプロイ

東京リージョンの CDK bootstrap は version 32 です。CloudFront 証明書を作る `us-east-1` は初回デプロイ前に bootstrap してください。

```sh
aws sso login --profile sso-admin-profile
pnpm --dir infra exec cdk bootstrap aws://444167236765/us-east-1 --profile sso-admin-profile
pnpm --dir web run check
pnpm --dir web test
pnpm --dir web build
pnpm --dir infra exec cdk synth --strict
pnpm --dir infra exec cdk diff --profile sso-admin-profile
pnpm --dir infra exec cdk deploy --profile sso-admin-profile --require-approval broadening
```

既存の Route 53 `app.nagutabby.uk` ゾーンを使います。スタックは `blog.app.nagutabby.uk` の A/AAAA Alias、ACM 証明書の検証レコード、ブログ専用 CloudFront 配信を作ります。Cloudflare 側の `nagutabby.uk` DNS は変更しません。監視用 CloudFront 配信は別スタック・別 DNS 名のままです。

初回デプロイで GitHub OIDC provider と `sveltekit-blog-github-deploy` ロールも作成します。Actions は `main` ブランチからのみこのロールを引き受け、CDK bootstrap の deploy/file-publishing/lookup ロールを引き受けます。以降の `main` push は `.github/workflows/deploy-aws.yml` が check・test・build・synth・diff・deploy を実行します。

## Secrets Manager

CDK は `sveltekit-blog/runtime` に Federation admin token を生成します。Cloudflare Secrets は読み戻せないため、デプロイ後に Mailtrap API token と送信元/BCC アドレスを保管元から入力し、新しい ActivityPub 鍵ペアを設定します。

```sh
aws sso login --profile sso-admin-profile
AWS_PROFILE=sso-admin-profile node web/scripts/configure-runtime-secrets.mjs
```

入力は端末に表示されません。値をソース、シェル引数、ログへ書かないでください。記事公開を呼ぶ外部システムには新しい `FEDERATION_ADMIN_TOKEN` を Secrets Manager から安全に渡し、URL を `https://blog.app.nagutabby.uk/rpc/federation-admin/publish-article-activity` へ変更してください。actor の公開鍵は新ドメインで発行し直します。

## データ移行の完了

2026-10-04 に Cloudflare D1 の全件を DynamoDB と照合しました。Follower 2件（following 0件）、RelayConnection 9件（connected 0件）について、内容・状態・日時・状態別索引の件数が一致しています。最新 SQL バックアップは `backend/migration-backups/sveltekit-blog-d1-2026-10-04T01-33-29-755Z.sql` に mode `0600` で保存し、Git 管理対象外です。照合後に本番と preview のブログ Worker、および D1 を削除しました。

旧ホスト `blog.nagutabby.uk` は `backend/wrangler.redirect.jsonc` の転送専用 Worker が受け持ちます。パスとクエリを保持して `https://blog.app.nagutabby.uk` へ301転送し、ブログ API や D1 は持ちません。デプロイ・更新は次のコマンドで行います。

```sh
pnpm --dir backend exec wrangler deploy --config wrangler.redirect.jsonc
```

## 本番の確認状況

2026-10-04 時点で AWS 本番の確認を完了しています。

- `https://blog.app.nagutabby.uk/` と拡張子なし記事 URL が 200 を返す
- `/sitemap.xml` と `/atom.xml` の URL が `blog.app.nagutabby.uk` を指す
- `GET /actor` と ActivityPub GET が応答し、`POST /actor/inbox` は 403
- API Gateway の直接 URL が CloudFront 秘密ヘッダーなしで 403
- 記事通知 API は未認証 POST に 401 を返す
- お問い合わせ API と認証済み記事公開 API は AWS Lambda で提供
- D1 のバックアップと DynamoDB の件数・内容・状態・日時・索引件数が一致

`nagutabby.uk` の Cloudflare DNS ゾーンは他のレコードを維持するため残しています。旧ホストには転送専用 Worker を設定し、旧 URL は `blog.app.nagutabby.uk` へ301転送します。現行サイトは `blog.app.nagutabby.uk` です。
