.PHONY: db-migrate
db-migrate:
	pnpm --dir web exec wrangler d1 migrations apply blog-db --local --config ../backend/wrangler.jsonc
