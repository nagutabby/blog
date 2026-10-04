# AWS resource rename runbook

The production migration replaces the `SveltekitBlog` and `SveltekitBlogEdgeCertificate` stacks with `Blog` and `BlogEdgeCertificate`. It preserves the public domain and copies the current data and secrets. CloudFront's distribution ID and ACM certificate ARN change. Removing the old distribution before creating the replacement causes a planned outage while CloudFront provisions and deploys the new distribution.

## 1. Build and prepare the target stacks

The `blogMigrationPrepare` context creates the target tables, secrets, APIs, Lambda functions, logs, site bucket, CloudFront Functions, and GitHub deployment role without creating the distribution or Route 53 aliases. The certificate can be provisioned at this stage. The deploy role refers to the account's existing GitHub OIDC provider; GitHub permits one provider for this URL per AWS account.

Build, review the prepare diff, then deploy:

```sh
pnpm --dir web run check
pnpm --dir web test
pnpm --dir web run build
pnpm --dir infra run build
env CI=true pnpm --dir infra exec cdk diff BlogEdgeCertificate Blog --context blogMigrationPrepare=true --profile sso-admin-profile
env CI=true pnpm --dir infra exec cdk deploy --all --context blogMigrationPrepare=true --profile sso-admin-profile --require-approval never
```

Confirm the new tables, secrets, APIs, functions, bucket, and `blog-github-deploy` role exist. Copy the currently served site's files without deleting source objects:

```sh
AWS_PROFILE=sso-admin-profile aws s3 sync s3://sveltekit-blog-site-444167236765-ap-northeast-1 s3://blog-site-444167236765-ap-northeast-1 --region ap-northeast-1
```

## 2. Copy and verify application state

Pause writes to the old application before the final copy. The read-only checks report item counts and mismatches, and the secret script never prints secret values. Apply copies only after confirming that the source tables are not receiving writes:

```sh
AWS_PROFILE=sso-admin-profile AWS_REGION=ap-northeast-1 node scripts/copy-dynamodb-tables.mjs
AWS_PROFILE=sso-admin-profile AWS_REGION=ap-northeast-1 node scripts/copy-dynamodb-tables.mjs --apply
AWS_PROFILE=sso-admin-profile AWS_REGION=ap-northeast-1 node scripts/copy-runtime-secrets.mjs
AWS_PROFILE=sso-admin-profile AWS_REGION=ap-northeast-1 node scripts/copy-runtime-secrets.mjs --apply
```

Run the read-only comparisons again. Confirm every item and secret matches. Do not resume writes to the old tables after the final comparison.

## 3. Remove old stacks and deploy the public target

Disable termination protection on `SveltekitBlog`. CloudFormation only accepts `--retain-resources` when a stack is already in `DELETE_FAILED`, so update the old stack template first to retain its shared GitHub OIDC custom resource (`GitHubActionsOidcProviderE284A1F7`). This leaves the account-wide provider available to the new role and other GitHub workflows. Keep the retained old tables, secrets, and site bucket for seven days. Delete the old certificate stack after the old distribution has been removed.

```sh
AWS_PROFILE=sso-admin-profile aws cloudformation update-termination-protection --no-enable-termination-protection --stack-name SveltekitBlog --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation get-template --stack-name SveltekitBlog --region ap-northeast-1 --query TemplateBody --output json > /tmp/sveltekit-blog-template.json
node --input-type=module -e 'import { readFile, writeFile } from "node:fs/promises"; const saved = JSON.parse(await readFile("/tmp/sveltekit-blog-template.json", "utf8")); const template = typeof saved === "string" ? JSON.parse(saved) : saved; const resource = template.Resources?.GitHubActionsOidcProviderE284A1F7; if (resource?.Type !== "Custom::AWSCDKOpenIdConnectProvider") throw new Error("Shared GitHub OIDC provider not found"); resource.DeletionPolicy = "Retain"; resource.UpdateReplacePolicy = "Retain"; await writeFile("/tmp/sveltekit-blog-retain-template.json", JSON.stringify(template));'
AWS_PROFILE=sso-admin-profile aws cloudformation validate-template --template-body file:///tmp/sveltekit-blog-retain-template.json --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation update-stack --stack-name SveltekitBlog --template-body file:///tmp/sveltekit-blog-retain-template.json --capabilities CAPABILITY_NAMED_IAM --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation wait stack-update-complete --stack-name SveltekitBlog --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation delete-stack --stack-name SveltekitBlog --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation wait stack-delete-complete --stack-name SveltekitBlog --region ap-northeast-1
AWS_PROFILE=sso-admin-profile aws cloudformation delete-stack --stack-name SveltekitBlogEdgeCertificate --region us-east-1
AWS_PROFILE=sso-admin-profile aws cloudformation wait stack-delete-complete --stack-name SveltekitBlogEdgeCertificate --region us-east-1
```

Review the final CDK diff, then deploy `BlogEdgeCertificate` and `Blog`. The public edge is enabled by default when `blogMigrationPrepare` is unset:

```sh
env CI=true pnpm --dir infra exec cdk diff BlogEdgeCertificate Blog --profile sso-admin-profile
env CI=true pnpm --dir infra exec cdk deploy --all --profile sso-admin-profile --require-approval never
```

Confirm the Route 53 alias points to the new distribution and the certificate is issued. Verify the home page, articles, sitemap, Atom feed, ActivityPub GET routes, inbox 403 behavior, API origin-header protection, and the old-host 301 redirect. An authenticated contact submission sends a real email, and an authenticated article notification sends a real federation message; do not use either as a smoke test. Exercise the GitHub Actions role before enabling `BLOG_RESOURCE_MIGRATION_READY=true` in repository variables.

## 4. Rollback data cleanup (completed 2026-10-04)

At the user's request, rollback copies were deleted before the planned seven-day observation window ended. Immediately before cleanup, the read-only comparison found all 3 follower records and all 10 relay records identical between old and new tables, both secret values matched without printing them, and CloudFront was serving the new bucket. The old unversioned site bucket contained 640 objects (36,768,337 bytes).

Deleted the old `sveltekit-blog-followers` and `sveltekit-blog-relay-connections` tables, `sveltekit-blog/runtime` and `sveltekit-blog/cloudfront-origin-header` secrets, and `sveltekit-blog-site-444167236765-ap-northeast-1` bucket. The live `blog-*` tables still contain 3 followers and 10 relays; the public site and `/healthz` returned HTTP 200 after cleanup. No old-prefixed tables, secrets, bucket, or OIDC helper Lambda remained. Keep the shared GitHub OIDC provider because the new deployment role uses it.

The one-time source D1 export retains its historical database name in `scripts/migrate-d1-to-dynamodb.mjs` and the migration record. Do not point Wrangler at that deleted remote D1; `backend/wrangler.jsonc` and `make db-migrate` use the separate local `blog-db` simulator.
