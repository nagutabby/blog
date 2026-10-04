# AWS CDK deployment

This project manages the production blog in `ap-northeast-1` and its CloudFront ACM certificate in `us-east-1`.

## Resources

- Private, encrypted S3 site bucket with CloudFront Origin Access Control
- CloudFront distribution for `blog.app.nagutabby.uk`, with separate API behaviors and security response headers
- Lambda/API Gateway HTTP API, guarded by a secret CloudFront origin header
- Dedicated Lambda/API Gateway route for article publication notifications, authorized with the federation admin bearer token and throttled at the HTTP API stage
- On-demand DynamoDB tables for followers and relay connections, with state/order GSIs, point-in-time recovery, and deletion protection
- Runtime Secrets Manager secret and generated CloudFront origin secret
- Route 53 A/AAAA Alias records in the existing `app.nagutabby.uk` hosted zone
- ACM DNS-validated certificate in `us-east-1`
- GitHub OIDC provider and a deploy role trusted only for `nagutabby/blog` `main`

The existing monitor distribution, its ACM certificates, and its DNS records are not imported into or modified by this stack.

## Commands

Run from the repository root:

For an existing production account, follow the resource migration runbook before the first deploy. GitHub Actions skips the deploy step until `BLOG_RESOURCE_MIGRATION_READY=true` is set after the new deployment role and stack are verified.

```sh
pnpm --dir web run build
pnpm --dir infra exec cdk synth --strict
pnpm --dir infra exec cdk diff --profile sso-admin-profile
pnpm --dir infra exec cdk deploy --all --profile sso-admin-profile --require-approval broadening
```

The Tokyo account environment is already bootstrapped at version 32. Bootstrap `us-east-1` once before the first deploy:

```sh
aws sso login --profile sso-admin-profile
pnpm --dir infra exec cdk bootstrap aws://444167236765/us-east-1 --profile sso-admin-profile
```

The build must run before `cdk synth` because the Lambda bundle imports the article metadata generated from `backend/content/`.

The dedicated article notification API uses the existing request format and bearer token:

```http
POST <ArticleNotificationApiEndpoint>
Authorization: Bearer <FEDERATION_ADMIN_TOKEN>
Content-Type: application/json

{"articleId":"article-id","changeType":"create"}
```

Use `create`, `update`, or `delete` for `changeType`. The token is stored in the `blog/runtime` Secrets Manager secret; it is not included in the repository or API Gateway logs. This endpoint is intentionally callable outside CloudFront. The main blog API continues to require the CloudFront origin header, and its `/rpc/federation-admin/*` route is no longer exposed there.

After the new deploy role has been created, GitHub Actions can assume `blog-github-deploy` through OIDC. That role is deliberately restricted to `nagutabby/blog`'s `main` branch and to the CDK bootstrap roles in the two deployment regions.

## State safety

The production stack has termination protection. DynamoDB tables, logs, buckets, and secrets use retain policies; the tables also have deletion protection and point-in-time recovery. Review every `cdk diff` before deployment. The only DNS records managed by this stack are `blog.app.nagutabby.uk` A and AAAA aliases plus the ACM validation record.

## Resource rename migration

The `Blog` and `BlogEdgeCertificate` stacks and `blog-*` resource names are the target state. The migration prepares new resources first, copies and verifies DynamoDB and Secrets Manager data, and syncs the current site objects. The old stacks are then deleted and the new stacks deployed with the same public domain. CloudFront's distribution ID and certificate ARN change, and the site is unavailable while the replacement distribution is deployed. Rollback tables, secrets, and site data were deleted on 2026-10-04 after full data comparison and an explicit cleanup request.

Use the production migration checklist in [`RESOURCE-RENAME.md`](./RESOURCE-RENAME.md). The GitHub OIDC provider is shared by both deploy roles and remains in IAM when the old stack is removed.
