# AGENTS.md

## デプロイ

`main` ブランチへの push で GitHub Actions（`.github/workflows/deploy-aws.yml`）が起動し、AWS へ自動デプロイされる。手動デプロイは不要。

1. `web` の依存関係をインストールし、`check` / `test` / `build` を実行
2. OIDC で AWS の IAM ロール（`blog-github-deploy`、リージョン `ap-northeast-1`）を引き受ける
3. `infra` で `cdk synth --strict` と `cdk diff` を実行
4. `cdk deploy --all --require-approval never` で全スタックをデプロイ

- `main` への直接 push は許可されている。ブランチや PR を経由する必要はない
- `main` への push は本番に直結する。push 前に `web` で `pnpm check` / `pnpm test` / `pnpm build` が通ることを確認する
- `concurrency` グループ `blog-production` により、デプロイは直列実行される（実行中のデプロイはキャンセルされない）
- `--require-approval never` のため、IAM 変更などもレビューなしで反映される。`infra` の変更は PR 上で `cdk diff` を確認する
- `test.yaml`（CI/CD）は push / PR 時にテストのみ実行し、デプロイはしない
