// @vitest-environment node

import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { articleNotificationApp } from './article-notification';
import { listArticles } from './content';
import { signHTTPRequest, verifyHTTPRequest } from './crypto';
import { FakeBlogDatabase, makeWorkerEnv, seedFollower, siteBaseURL } from './test-utils';

vi.stubGlobal('crypto', webcrypto);

function toPEM(label: string, bytes: ArrayBuffer): string {
  const binary = Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join('');
  const encoded = btoa(binary).match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

async function makeKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const [privateBytes, publicBytes] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('spki', pair.publicKey)
  ]);
  return {
    privateKeyPEM: toPEM('PRIVATE KEY', privateBytes),
    publicKeyPEM: toPEM('PUBLIC KEY', publicBytes)
  };
}

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, siteBaseURL), init);
}

async function request(path: string, init: RequestInit | undefined, env = makeWorkerEnv()): Promise<Response> {
  return app.fetch(makeRequest(path, init), env);
}

async function notificationRequest(path: string, init: RequestInit | undefined, env = makeWorkerEnv()): Promise<Response> {
  return articleNotificationApp.fetch(makeRequest(path, init), env);
}

async function signedInboxRequest(activity: unknown, actorID: string, privateKeyPEM: string): Promise<Request> {
  const body = JSON.stringify(activity);
  const target = `${siteBaseURL}/actor/inbox`;
  const signature = await signHTTPRequest(target, 'POST', body, `${actorID}#main-key`, privateKeyPEM);
  return new Request(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/activity+json',
      Date: signature.date,
      Digest: signature.digest,
      Signature: signature.signature
    },
    body
  });
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Hono Worker routes', () => {
  it('serves health and ActivityPub actor responses', async () => {
    const env = makeWorkerEnv();
    const health = await request('/healthz', undefined, env);
    expect(health.status).toBe(200);
    await expect(health.text()).resolves.toBe('ok');

    const actor = await request('/actor', {
      headers: { Accept: 'application/ld+json' }
    }, env);
    expect(actor.status).toBe(200);
    expect(actor.headers.get('Content-Type')).toContain('application/ld+json');
    await expect(actor.json()).resolves.toMatchObject({
      type: 'Service',
      preferredUsername: 'article'
    });
  });

  it('returns ActivityPub follower pages and article notes', async () => {
    const db = new FakeBlogDatabase();
    for (let index = 0; index < 21; index += 1) {
      seedFollower(db, `https://social.example/users/${index}`, 'unused-public-key');
    }
    const env = makeWorkerEnv(db);

    const page = await request('/actor/followers?page=1', undefined, env);
    const pageBody = await page.json() as { orderedItems: string[]; next?: string };
    expect(page.status).toBe(200);
    expect(pageBody.orderedItems).toHaveLength(20);
    expect(pageBody.next).toBe(`${siteBaseURL}/actor/followers?page=2`);

    const article = listArticles()[0];
    expect(article).toBeDefined();
    const note = await request(`/api/articles/${encodeURIComponent(article!.id)}`, undefined, env);
    await expect(note.json()).resolves.toMatchObject({
      id: `${siteBaseURL}/api/articles/${article!.id}`,
      type: 'Note',
      name: article!.title
    });

    const unacceptable = await request('/actor', {
      headers: { Accept: 'text/html' }
    }, env);
    expect(unacceptable.status).toBe(406);
  });

  it('returns field errors for invalid contact submissions without sending email', async () => {
    const sendEmail = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', sendEmail);

    const response = await request('/rpc/contact/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'invalid', text: '', imRobot: true })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      errors: {
        imRobot: expect.any(String),
        name: expect.any(String),
        email: expect.any(String),
        text: expect.any(String)
      }
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports Mailtrap delivery failures to contact clients', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 429 })));

    const response = await request('/rpc/contact/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice',
        email: 'alice@example.com',
        text: 'Hello',
        imRobot: false
      })
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Contact delivery failed' });
  });

  it('sends escaped contact details to Mailtrap', async () => {
    const sendEmail = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', sendEmail);

    const response = await request('/rpc/contact/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '<Alice>',
        email: 'alice@example.com',
        text: '<script>alert("x")</script>',
        imRobot: false
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ errors: {} });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(sendEmail.mock.calls[0]?.[1]?.body)) as { html: string };
    expect(payload.html).toContain('&lt;Alice&gt;');
    expect(payload.html).toContain('&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;');
  });

  it('does not expose article publication notifications on the main API', async () => {
    const response = await request('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ articleId: 'article', changeType: 'delete' })
    });

    expect(response.status).toBe(404);
  });

  it('requires the Bearer scheme on federation admin requests', async () => {
    const unsetEnv = makeWorkerEnv();
    unsetEnv.FEDERATION_ADMIN_TOKEN = '';
    const rawToken = await notificationRequest('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: { Authorization: 'test-admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: 'article', changeType: 'delete' })
    });
    const wrongToken = await notificationRequest('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: 'article', changeType: 'delete' })
    });
    const unsetToken = await notificationRequest('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: { Authorization: 'Bearer any-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: 'article', changeType: 'delete' })
    }, unsetEnv);

    expect(rawToken.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    expect(unsetToken.status).toBe(401);
  });

  it('publishes a signed article activity to connected relays with a valid Bearer token', async () => {
    const db = new FakeBlogDatabase();
    db.relayConnections.set('https://relay.example/actor', {
      id: 1,
      actorId: 'https://relay.example/actor',
      inbox: 'https://relay.example/inbox',
      connected: true,
      lastAcceptedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const env = makeWorkerEnv(db);
    const keys = await makeKeyPair();
    env.ACTOR_PRIVATE_KEY_PEM = keys.privateKeyPEM;
    const deliver = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', deliver);
    const article = listArticles()[0];
    expect(article).toBeDefined();

    const response = await notificationRequest('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ articleId: article!.id, changeType: 'create' })
    }, env);

    expect(response.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [inboxURL, init] = deliver.mock.calls[0]!;
    const outgoingHeaders = new Headers(init?.headers);
    const body = String(init?.body);
    const activity = JSON.parse(body) as { type: string; object: { name: string }; signature: { signatureValue: string } };
    expect(inboxURL).toBe('https://relay.example/inbox');
    expect(outgoingHeaders.get('Signature')).toContain('keyId=');
    expect(activity).toMatchObject({ type: 'Create', object: { name: article!.title } });
    expect(activity.signature.signatureValue).not.toBe('');

    const signedRequest = new Request(String(inboxURL), {
      method: 'POST',
      headers: outgoingHeaders,
      body
    });
    await expect(verifyHTTPRequest(signedRequest, new TextEncoder().encode(body), keys.publicKeyPEM)).resolves.toBeUndefined();
  });

  it('continues publishing when one relay delivery fails', async () => {
    const db = new FakeBlogDatabase();
    for (const [index, actorID] of ['https://relay-a.example/actor', 'https://relay-b.example/actor'].entries()) {
      db.relayConnections.set(actorID, {
        id: index + 1,
        actorId: actorID,
        inbox: `${new URL(actorID).origin}/inbox`,
        connected: true,
        lastAcceptedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
    }
    const env = makeWorkerEnv(db);
    env.ACTOR_PRIVATE_KEY_PEM = (await makeKeyPair()).privateKeyPEM;
    let attempt = 0;
    const deliver = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempt += 1;
      return new Response(null, { status: attempt === 1 ? 503 : 202 });
    });
    vi.stubGlobal('fetch', deliver);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const article = listArticles()[0];
    expect(article).toBeDefined();

    const response = await notificationRequest('/rpc/federation-admin/publish-article-activity', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-admin-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ articleId: article!.id, changeType: 'update' })
    }, env);

    expect(response.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('verifies a signed self-Delete before unfollowing a known follower', async () => {
    const actorID = 'https://social.example/users/alice';
    const db = new FakeBlogDatabase();
    const keys = await makeKeyPair();
    seedFollower(db, actorID, keys.publicKeyPEM);
    const inboxRequest = await signedInboxRequest({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Delete',
      actor: actorID,
      object: { id: actorID, type: 'Tombstone' }
    }, actorID, keys.privateKeyPEM);
    const response = await app.fetch(inboxRequest, makeWorkerEnv(db));

    expect(response.status).toBe(200);
    expect(db.followers.get(actorID)?.following).toBe(false);
  });

  it('records a signed Follow and sends a signed Accept to the remote inbox', async () => {
    const actorID = 'https://social.example/users/alice';
    const remoteInbox = 'https://social.example/inbox';
    const db = new FakeBlogDatabase();
    const remoteKeys = await makeKeyPair();
    const localKeys = await makeKeyPair();
    const env = makeWorkerEnv(db);
    env.ACTOR_PRIVATE_KEY_PEM = localKeys.privateKeyPEM;
    const outboundRequests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const remoteFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      outboundRequests.push({ url, init });
      if (url === actorID) {
        return new Response(JSON.stringify({
          inbox: remoteInbox,
          publicKey: { publicKeyPem: remoteKeys.publicKeyPEM }
        }), { status: 200 });
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal('fetch', remoteFetch);

    const response = await app.fetch(await signedInboxRequest({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Follow',
      actor: actorID,
      object: `${siteBaseURL}/actor`
    }, actorID, remoteKeys.privateKeyPEM), env);

    expect(response.status).toBe(200);
    expect(db.followers.get(actorID)).toMatchObject({ actorId: actorID, following: true, inbox: remoteInbox });
    expect(outboundRequests.map(({ url }) => url)).toEqual([actorID, remoteInbox]);
    const delivery = outboundRequests[1]!;
    const headers = new Headers(delivery.init?.headers);
    expect(headers.get('Signature')).toContain(`${siteBaseURL}/actor#main-key`);
    await expect(response.json()).resolves.toMatchObject({ type: 'Accept', actor: `${siteBaseURL}/actor` });
  });

  it('applies signed Undo and Accept activities to follower and relay state', async () => {
    const followerID = 'https://social.example/users/alice';
    const relayID = 'https://relay.example/actor';
    const remoteInbox = 'https://social.example/inbox';
    const followerKeys = await makeKeyPair();
    const relayKeys = await makeKeyPair();
    const localKeys = await makeKeyPair();
    const db = new FakeBlogDatabase();
    seedFollower(db, followerID, followerKeys.publicKeyPEM);
    const env = makeWorkerEnv(db);
    env.ACTOR_PRIVATE_KEY_PEM = localKeys.privateKeyPEM;
    const remoteFetch = vi.fn(async (input: RequestInfo | URL) => {
      const actorID = String(input);
      const keys = actorID === followerID ? followerKeys : relayKeys;
      return new Response(JSON.stringify({
        inbox: remoteInbox,
        publicKey: { publicKeyPem: keys.publicKeyPEM }
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', remoteFetch);

    const undoResponse = await app.fetch(await signedInboxRequest({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Undo',
      actor: followerID,
      object: { type: 'Follow', object: `${siteBaseURL}/actor` }
    }, followerID, followerKeys.privateKeyPEM), env);
    expect(undoResponse.status).toBe(200);
    expect(db.followers.get(followerID)?.following).toBe(false);

    const acceptResponse = await app.fetch(await signedInboxRequest({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Accept',
      actor: relayID,
      object: { type: 'Follow' }
    }, relayID, relayKeys.privateKeyPEM), env);
    expect(acceptResponse.status).toBe(200);
    expect(db.relayConnections.get(relayID)).toMatchObject({
      actorId: relayID,
      inbox: remoteInbox,
      connected: true
    });
    expect(remoteFetch).toHaveBeenCalledTimes(3);
  });
});
