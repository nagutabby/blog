// @vitest-environment node

import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handler, toRequest, toLambdaResponse } from './lambda';
import { handler as articleNotificationHandler } from './article-notification-lambda';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AWS Lambda HTTP API adapter', () => {
  it('accepts a bearer-authenticated article notification without the CloudFront origin header', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubEnv('RUNTIME_SECRET_ARN', 'article-notification-runtime-secret-arn');
    vi.stubEnv('FOLLOWER_TABLE', 'followers');
    vi.stubEnv('RELAY_TABLE', 'relays');
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }).toString();

    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({
      SecretString: JSON.stringify({
        ACTOR_PUBLIC_KEY_PEM: 'public-key',
        ACTOR_PRIVATE_KEY_PEM: privateKey,
        FEDERATION_ADMIN_TOKEN: 'article-notification-token',
        EMAIL_API_TOKEN: 'email-token',
        FROM_ADDRESS: 'from@example.com',
        BCC_ADDRESS: 'bcc@example.com'
      })
    } as never);
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({ Items: [] } as never);

    const result = await articleNotificationHandler({
      requestContext: { domainName: 'api.example.test', http: { method: 'POST' } },
      rawPath: '/rpc/federation-admin/publish-article-activity',
      rawQueryString: '',
      headers: {
        authorization: 'Bearer article-notification-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ articleId: 'deleted-article', changeType: 'delete' })
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{}');
  });

  it('rejects article notification requests with an invalid bearer token', async () => {
    const result = await articleNotificationHandler({
      requestContext: { domainName: 'api.example.test', http: { method: 'POST' } },
      rawPath: '/rpc/federation-admin/publish-article-activity',
      rawQueryString: '',
      headers: {
        authorization: 'Bearer invalid-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ articleId: 'deleted-article', changeType: 'delete' })
    });

    expect(result.statusCode).toBe(401);
  });

  it('rejects API Gateway calls without the CloudFront origin header', async () => {
    vi.stubEnv('ORIGIN_HEADER_SECRET_ARN', '');
    const result = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/actor',
      rawQueryString: ''
    });

    expect(result.statusCode).toBe(403);
    expect(result.body).toBe('Forbidden');
  });

  it('forwards a request with the CloudFront origin header to Hono', async () => {
    vi.stubEnv('ORIGIN_HEADER_SECRET_ARN', 'origin-secret-arn');
    vi.stubEnv('RUNTIME_SECRET_ARN', 'runtime-secret-arn');
    vi.stubEnv('FOLLOWER_TABLE', 'followers');
    vi.stubEnv('RELAY_TABLE', 'relays');
    vi.spyOn(SecretsManagerClient.prototype, 'send')
      .mockResolvedValueOnce({ SecretString: 'origin-secret-value' } as never)
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({
          ACTOR_PUBLIC_KEY_PEM: 'public-key',
          ACTOR_PRIVATE_KEY_PEM: 'private-key',
          FEDERATION_ADMIN_TOKEN: 'admin-token',
          EMAIL_API_TOKEN: 'email-token',
          FROM_ADDRESS: 'from@example.com',
          BCC_ADDRESS: 'bcc@example.com'
        })
      } as never);

    const result = await handler({
      requestContext: { domainName: 'api.example.test', http: { method: 'GET' } },
      rawPath: '/healthz',
      rawQueryString: '',
      headers: { 'x-blog-origin-verify': 'origin-secret-value' }
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('ok');
  });

  it('serves the ActivityPub actor through Lambda using the new canonical domain', async () => {
    vi.stubEnv('ORIGIN_HEADER_SECRET_ARN', 'origin-secret-arn');
    const result = await handler({
      requestContext: { domainName: 'api.example.test', http: { method: 'GET' } },
      rawPath: '/actor',
      rawQueryString: '',
      headers: { 'X-Blog-Origin-Verify': 'origin-secret-value', accept: 'application/ld+json' }
    });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      id: 'https://blog.app.nagutabby.uk/actor',
      publicKey: { id: 'https://blog.app.nagutabby.uk/actor#main-key' }
    });
  });

  it('rejects the same API Gateway event without the CloudFront header', async () => {
    vi.stubEnv('ORIGIN_HEADER_SECRET_ARN', 'origin-secret-arn');
    const result = await handler({
      requestContext: { domainName: 'api.example.test', http: { method: 'GET' } },
      rawPath: '/healthz',
      rawQueryString: '',
      headers: {}
    });

    expect(result.statusCode).toBe(403);
  });

  it('preserves the raw query and JSON body when converting an API Gateway event', async () => {
    const request = toRequest({
      requestContext: { domainName: 'api.example.test', http: { method: 'POST' } },
      rawPath: '/rpc/contact/submit',
      rawQueryString: 'source=a%2Fb',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"Alice"}'
    });

    expect(request.url).toBe('https://api.example.test/rpc/contact/submit?source=a%2Fb');
    expect(request.headers.get('content-type')).toBe('application/json');
    await expect(request.json()).resolves.toEqual({ name: 'Alice' });
  });

  it('converts a Hono response to API Gateway payload format 2.0', async () => {
    const result = await toLambdaResponse(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    expect(result).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      isBase64Encoded: false
    });
  });
});
