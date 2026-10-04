# astro-svelte-blog

Astro + Svelte (`web/`)で構築したブログです。フロントエンドは静的出力し、AWS 上の CloudFront と S3 から配信します。Hono API は Lambda と API Gateway で動作します。

## アーキテクチャ

```
外部リクエスト
     │
     ▼
CloudFront ── 静的ページ・画像 ── S3
     │
     └─ API パス ── API Gateway ── Lambda (Hono)
                                  ├─ ActivityPub
                                  ├─ お問い合わせ・記事通知
                                  └─ DynamoDB (Follower / RelayConnection)
```

- AWS リソースは [`infra/`](infra/README.md) の CDK で管理します。本番サイトは `https://blog.app.nagutabby.uk` です。
- API ハンドラーは [`web/src/worker/`](web/src/worker/) にあり、Lambda 用アダプターが Hono アプリを実行します。
- 記事・書評の Markdown は `backend/content/` にあり、Astro のビルドと記事メタデータ生成で読み込みます。
- ローカル開発と本番構成は [`backend/README.md`](backend/README.md) を参照してください。

## ライセンス

プログラム、コンポーネント、スタイルシート等のソースコードはMITライセンスです。詳細は[LICENSE-MIT](LICENSE-MIT)を確認してください。

`backend/content/`の記事・書評、および`web/static/content/`の画像等の静的アセットはCC BY 4.0です。詳細は[LICENSE-CC-BY-4.0](LICENSE-CC-BY-4.0)を確認してください。
