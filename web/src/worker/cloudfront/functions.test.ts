import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const staticRewriteSource = readFileSync(resolve(process.cwd(), 'src/worker/cloudfront/static-url-rewrite.js'), 'utf8');
const inboxBlockSource = readFileSync(resolve(process.cwd(), 'src/worker/cloudfront/block-inbox-post.js'), 'utf8');

function cloudFrontFunction(source: string): (event: unknown) => unknown {
  return (event) => JSON.parse(JSON.stringify(runInNewContext(`${source}\nhandler(event);`, { event })));
}

describe('CloudFront viewer request functions', () => {
  it('rewrites Astro clean paths while preserving query strings', () => {
    const rewrite = cloudFrontFunction(staticRewriteSource);
    const request = { method: 'GET', uri: '/articles/example', querystring: { page: { value: '2' } } };

    expect(rewrite({ request })).toEqual({
      method: 'GET',
      uri: '/articles/example.html',
      querystring: { page: { value: '2' } }
    });
    expect(rewrite({ request: { method: 'GET', uri: '/', querystring: {} } })).toMatchObject({ uri: '/index.html' });
    expect(rewrite({ request: { method: 'GET', uri: '/sitemap.xml', querystring: {} } })).toMatchObject({ uri: '/sitemap.xml' });
  });

  it('rejects only POST requests to the ActivityPub inbox', () => {
    const block = cloudFrontFunction(inboxBlockSource);
    expect(block({ request: { method: 'POST', uri: '/actor/inbox', headers: {} } })).toMatchObject({ statusCode: 403 });
    expect(block({ request: { method: 'GET', uri: '/actor/inbox', headers: {} } })).toMatchObject({ method: 'GET' });
    expect(block({ request: { method: 'POST', uri: '/actor', headers: {} } })).toMatchObject({ method: 'POST' });
  });
});
