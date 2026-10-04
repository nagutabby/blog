import type { Follower } from './db';
import { getArticle, listArticles, type Article } from './content';
import { normalizePEM, signHTTPRequest, verifyHTTPRequest } from './crypto';
import type { WorkerEnv } from './bindings';

type Activity = Record<string, unknown> & {
  '@context'?: unknown;
  type?: unknown;
  actor?: unknown;
  object?: unknown;
};

type RequiredActivity = Activity & {
  '@context': unknown;
  type: string;
  actor: string;
};

interface RemoteActor {
  inbox: string;
  publicKey: {
    id?: string;
    owner?: string;
    publicKeyPem: string;
  };
}

const activityJSONContentType = 'application/activity+json';
const actorCacheControl = 'max-age=0, private, must-revalidate';
const ldJSONContentType = 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const collectionPageSize = 20;
const nodeInfoRel20 = 'http://nodeinfo.diaspora.software/ns/schema/2.0';
const nodeInfoRel21 = 'http://nodeinfo.diaspora.software/ns/schema/2.1';
const nodeInfo20ContentType = `application/json; profile="${nodeInfoRel20}#"`;
const nodeInfo21ContentType = `application/json; profile="${nodeInfoRel21}#"`;
const acknowledgedActivityTypes = new Set([
  'Create', 'Update', 'Like', 'Announce', 'Flag', 'Add', 'Remove', 'Block', 'Move'
]);

function siteBaseURL(env: WorkerEnv): string {
  return (env.SITE_BASE_URL || 'https://blog.app.nagutabby.uk').replace(/\/$/, '');
}

function actorURL(env: WorkerEnv): string {
  return `${siteBaseURL(env)}/actor`;
}

function actorKeyID(env: WorkerEnv): string {
  return `${actorURL(env)}#main-key`;
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) responseHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function plainResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function jsonError(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'application/json' } });
}

function parseAcceptMediaTypes(header: string): string[] {
  const entries: Array<{ mediaType: string; q: number; order: number }> = [];
  for (const [order, part] of header.split(',').entries()) {
    const segments = part.trim().split(';');
    const mediaType = (segments[0] ?? '').trim().toLowerCase();
    if (!mediaType) continue;
    let q = 1;
    for (const param of segments.slice(1)) {
      const value = param.trim().match(/^q=(.*)$/)?.[1];
      if (value !== undefined) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q > 0) entries.push({ mediaType, q, order });
  }
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries.map(({ mediaType }) => mediaType);
}

function negotiateAPContentType(acceptHeader: string): string | undefined {
  if (!acceptHeader.trim()) return activityJSONContentType;
  for (const mediaType of parseAcceptMediaTypes(acceptHeader)) {
    if (['*/*', 'application/*', 'application/json', 'application/activity+json'].includes(mediaType)) {
      return activityJSONContentType;
    }
    if (mediaType === 'application/ld+json') return ldJSONContentType;
  }
  return undefined;
}

function activityJSON(request: Request, body: unknown, status = 200): Response {
  const contentType = negotiateAPContentType(request.headers.get('Accept') ?? '');
  if (!contentType) return plainResponse(406, 'Not Acceptable');
  return jsonResponse(body, status, {
    'Content-Type': contentType,
    'Cache-Control': actorCacheControl
  });
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function isoMillis(date: Date): string {
  return date.toISOString().slice(0, 23) + 'Z';
}

function hostOf(rawURL: string): string {
  try {
    return new URL(rawURL).host;
  } catch {
    return rawURL;
  }
}

function parsePageNumber(raw: string): number | undefined {
  if (!/^[+-]?\d+$/.test(raw)) return undefined;
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page < 1) return undefined;
  return page;
}

function paginate<T>(items: T[], pageNumber: number, pageSize: number): { items: T[]; hasMore: boolean } {
  const start = (pageNumber - 1) * pageSize;
  if (start < 0 || start >= items.length) return { items: [], hasMore: false };
  const end = Math.min(start + pageSize, items.length);
  return { items: items.slice(start, end), hasMore: end < items.length };
}

function writeCollectionPage(
  request: Request,
  collectionURL: string,
  pageNumber: number,
  items: unknown,
  hasMore: boolean
): Response {
  const body: Record<string, unknown> = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${collectionURL}?page=${pageNumber}`,
    type: 'OrderedCollectionPage',
    partOf: collectionURL,
    orderedItems: items
  };
  if (hasMore) body.next = `${collectionURL}?page=${pageNumber + 1}`;
  if (pageNumber > 1) body.prev = `${collectionURL}?page=${pageNumber - 1}`;
  return activityJSON(request, body);
}

function buildArticleNote(article: Article, env: WorkerEnv): Record<string, unknown> {
  const base = siteBaseURL(env);
  const articleURL = `${base}/api/articles/${article.id}`;
  return {
    id: articleURL,
    type: 'Note',
    attributedTo: actorURL(env),
    name: article.title,
    content: `<p>${article.title}</p><a href="${base}/articles/${article.id}" target="_blank">${base}/articles/${article.id}</a>`,
    published: isoMillis(article.publishedAt),
    url: articleURL,
    to: ['https://www.w3.org/ns/activitystreams#Public']
  };
}

function buildCreateActivity(article: Article, env: WorkerEnv): Record<string, unknown> {
  const note = buildArticleNote(article, env);
  return {
    id: `${String(note.id)}/create`,
    type: 'Create',
    actor: actorURL(env),
    published: note.published,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: note
  };
}

function webfinger(request: Request, env: WorkerEnv): Response {
  const resource = new URL(request.url).searchParams.get('resource');
  if (!resource) return plainResponse(400, 'Resource parameter required');
  const expected = `acct:article@${hostOf(siteBaseURL(env))}`;
  if (resource !== expected) return plainResponse(404, 'User not found');
  return jsonResponse({
    subject: expected,
    links: [
      { rel: 'self', type: activityJSONContentType, href: actorURL(env) },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: siteBaseURL(env) }
    ]
  }, 200, {
    'Content-Type': 'application/jrd+json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
}

function actor(request: Request, env: WorkerEnv): Response {
  return activityJSON(request, {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: actorURL(env),
    type: 'Service',
    preferredUsername: 'article',
    name: 'nagutabbyの考え事',
    summary: '<p>ブログ記事を投稿するBotアカウントです。</p><p>運用者: <a href="https://mastodon.social/@nagutabby" target="_blank">@nagutabby</a></p>',
    url: siteBaseURL(env),
    inbox: `${actorURL(env)}/inbox`,
    outbox: `${actorURL(env)}/outbox`,
    following: `${actorURL(env)}/following`,
    followers: `${actorURL(env)}/followers`,
    discoverable: true,
    publicKey: {
      id: actorKeyID(env),
      owner: actorURL(env),
      publicKeyPem: normalizePEM(env.ACTOR_PUBLIC_KEY_PEM || '')
    },
    icon: {
      type: 'Image',
      mediaType: 'image/png',
      url: `${siteBaseURL(env)}/images/Microsoft-Fluentui-Emoji-3d-Cat-3d.500.png`
    }
  });
}

async function followers(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const collectionURL = `${actorURL(env)}/followers`;
  const rawPage = url.searchParams.get('page');
  try {
    if (rawPage === null || rawPage === '') {
      const totalItems = await env.DB.countActiveFollowers();
      return activityJSON(request, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionURL,
        type: 'OrderedCollection',
        totalItems,
        first: `${collectionURL}?page=1`
      });
    }
    const pageNumber = parsePageNumber(rawPage);
    if (!pageNumber || (pageNumber - 1) * collectionPageSize > Number.MAX_SAFE_INTEGER - collectionPageSize) {
      return plainResponse(400, 'Invalid page parameter');
    }
    const actorIDs = await env.DB.listActiveFollowerActorIDs(
      collectionPageSize + 1,
      (pageNumber - 1) * collectionPageSize
    );
    const hasMore = actorIDs.length > collectionPageSize;
    if (hasMore) actorIDs.length = collectionPageSize;
    return writeCollectionPage(request, collectionURL, pageNumber, actorIDs, hasMore);
  } catch (error) {
    console.error(JSON.stringify({ message: 'follower collection query failed', error: String(error) }));
    return plainResponse(500, 'Internal Server Error');
  }
}

async function following(request: Request, env: WorkerEnv): Promise<Response> {
  const collectionURL = `${actorURL(env)}/following`;
  try {
    const rawPage = new URL(request.url).searchParams.get('page');
    if (rawPage === null || rawPage === '') {
      const totalItems = await env.DB.countConnectedRelayConnections();
      return activityJSON(request, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionURL,
        type: 'OrderedCollection',
        totalItems,
        first: `${collectionURL}?page=1`
      });
    }
    const pageNumber = parsePageNumber(rawPage);
    if (!pageNumber) return plainResponse(400, 'Invalid page parameter');
    const actorIDs = await env.DB.listConnectedRelayActorIDs(
      collectionPageSize + 1,
      (pageNumber - 1) * collectionPageSize
    );
    const hasMore = actorIDs.length > collectionPageSize;
    if (hasMore) actorIDs.length = collectionPageSize;
    return writeCollectionPage(request, collectionURL, pageNumber, actorIDs, hasMore);
  } catch (error) {
    console.error(JSON.stringify({ message: 'following collection query failed', error: String(error) }));
    return plainResponse(500, 'Internal Server Error');
  }
}

function nodeInfoDocument(version: '2.0' | '2.1'): Record<string, unknown> {
  const software: Record<string, string> = { name: 'blog', version: '1.0.0' };
  if (version === '2.1') software.repository = 'https://github.com/nagutabby/blog';
  return {
    version,
    software,
    protocols: ['activitypub'],
    services: { inbound: [], outbound: [] },
    openRegistration: false,
    usage: {
      users: { total: 1, activeMonth: 1, activeHalfyear: 1 },
      localPosts: listArticles().length
    },
    metadata: {}
  };
}

function nodeInfo(version: '2.0' | '2.1'): Response {
  return jsonResponse(nodeInfoDocument(version), 200, {
    'Content-Type': version === '2.1' ? nodeInfo21ContentType : nodeInfo20ContentType
  });
}

async function articleNote(request: Request, articleID: string, env: WorkerEnv): Promise<Response> {
  if (!articleID) return plainResponse(404, 'Article not found');
  const article = getArticle(articleID);
  if (!article) return plainResponse(404, 'Article not found');
  const contentType = negotiateAPContentType(request.headers.get('Accept') ?? '');
  if (!contentType) return plainResponse(406, 'Not Acceptable');
  return jsonResponse(buildArticleNote(article, env), 200, { 'Content-Type': contentType });
}

async function outbox(request: Request, env: WorkerEnv): Promise<Response> {
  const outboxURL = `${actorURL(env)}/outbox`;
  const articles = listArticles();
  const rawPage = new URL(request.url).searchParams.get('page');
  if (rawPage === null || rawPage === '') {
    return activityJSON(request, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: outboxURL,
      type: 'OrderedCollection',
      totalItems: articles.length,
      first: `${outboxURL}?page=1`
    });
  }
  const pageNumber = parsePageNumber(rawPage);
  if (!pageNumber) return plainResponse(400, 'Invalid page parameter');
  const start = (pageNumber - 1) * collectionPageSize;
  if (start < 0 || start > articles.length) return plainResponse(404, 'Page not found');
  const page = paginate(articles, pageNumber, collectionPageSize);
  const items = page.items.map((post) => buildCreateActivity(post, env));
  return writeCollectionPage(request, outboxURL, pageNumber, items, page.hasMore);
}

async function fetchActor(actorID: string): Promise<RemoteActor> {
  const response = await fetch(actorID, {
    headers: { Accept: activityJSONContentType }
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('federation: could not fetch actor information');
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('federation: could not fetch actor information');
  }
  const publicKey = payload.publicKey;
  if (
    typeof payload.inbox !== 'string'
    || !isRecord(publicKey)
    || typeof publicKey.publicKeyPem !== 'string'
  ) {
    throw new Error('federation: could not fetch actor information');
  }
  return { inbox: payload.inbox, publicKey: { publicKeyPem: publicKey.publicKeyPem } };
}

async function sendAccept(env: WorkerEnv, activity: Activity, inbox: string): Promise<void> {
  const accept = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${siteBaseURL(env)}/activities/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: actorURL(env),
    object: activity
  };
  const body = JSON.stringify(accept);
  const headers = await signHTTPRequest(inbox, 'POST', body, actorKeyID(env), env.ACTOR_PRIVATE_KEY_PEM || '');
  const response = await fetch(inbox, {
    method: 'POST',
    headers: {
      Date: headers.date,
      Digest: headers.digest,
      Signature: headers.signature,
      'Content-Type': activityJSONContentType,
      Accept: activityJSONContentType
    },
    body
  });
  const status = response.status;
  await response.body?.cancel();
  if (!response.ok) throw new Error(`federation: accept delivery failed with status ${status}`);
}

function isRelayUserAgent(userAgent: string): boolean {
  return userAgent.toLowerCase().includes('relay');
}

function writeForbiddenRelayResponse(request: Request, userAgent: string): Response {
  const url = new URL(request.url);
  return activityJSON(request, {
    error: 'Forbidden',
    status: 403,
    message: 'Relay server access is not permitted',
    details: {
      reason: 'This server does not accept requests from relay servers',
      path: url.pathname,
      userAgent
    }
  }, 403);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deletedObjectID(object: unknown): string {
  if (typeof object === 'string') return object;
  if (isRecord(object) && typeof object.id === 'string') return object.id;
  return '';
}

async function handleDelete(
  request: Request,
  env: WorkerEnv,
  body: Uint8Array,
  activity: Activity & { actor: string }
): Promise<Response> {
  const objectID = deletedObjectID(activity.object);
  if (!objectID || objectID !== activity.actor) return new Response(null, { status: 202 });

  let existing: Follower | null;
  try {
    existing = await env.DB.getFollowerByActorID(activity.actor);
  } catch {
    return new Response(null, { status: 202 });
  }
  if (!existing) return new Response(null, { status: 202 });

  try {
    await verifyHTTPRequest(request, body, existing.publicKeyPem);
  } catch {
    // The actor document is normally gone by the time its Delete arrives.
    // Ignore unverifiable self-deletions rather than removing a follower.
    return new Response(null, { status: 202 });
  }

  try {
    await env.DB.unfollowByActorID({
      actorId: activity.actor,
      inbox: existing.inbox,
      publicKeyPem: existing.publicKeyPem,
      now: nowTimestamp()
    });
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(JSON.stringify({ message: 'failed to mark deleted actor as unfollowed', error: String(error) }));
    return jsonError(500, String(error));
  }
}

async function handleFollow(
  request: Request,
  env: WorkerEnv,
  activity: Activity & { actor: string },
  actorInfo: RemoteActor
): Promise<Response> {
  try {
    await env.DB.upsertFollower({
      actorId: activity.actor,
      inbox: actorInfo.inbox,
      publicKeyPem: actorInfo.publicKey.publicKeyPem,
      now: nowTimestamp()
    });
    await sendAccept(env, activity, actorInfo.inbox);
    return activityJSON(request, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${siteBaseURL(env)}/activities/${crypto.randomUUID()}`,
      type: 'Accept',
      actor: actorURL(env),
      object: activity
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'failed to accept Follow activity', error: String(error) }));
    return jsonError(500, String(error));
  }
}

async function handleUndo(
  request: Request,
  env: WorkerEnv,
  activity: Activity & { actor: string },
  actorInfo: RemoteActor
): Promise<Response> {
  if (!isRecord(activity.object) || activity.object.type !== 'Follow') {
    return plainResponse(400, 'Invalid Undo activity');
  }

  try {
    await env.DB.unfollowByActorID({
      actorId: activity.actor,
      inbox: actorInfo.inbox,
      publicKeyPem: actorInfo.publicKey.publicKeyPem,
      now: nowTimestamp()
    });
    await sendAccept(env, activity, actorInfo.inbox);
    return activityJSON(request, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Accept',
      actor: actorURL(env),
      object: activity
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'failed to accept Undo activity', error: String(error) }));
    return jsonError(500, String(error));
  }
}

async function handleAccept(
  env: WorkerEnv,
  activity: Activity & { actor: string },
  actorInfo: RemoteActor
): Promise<Response> {
  if (!isRecord(activity.object) || !['Follow', 'Subscribe'].includes(String(activity.object.type))) {
    return plainResponse(400, 'Invalid Accept activity');
  }
  try {
    await env.DB.upsertRelayConnectionAccepted({
      actorId: activity.actor,
      inbox: actorInfo.inbox,
      now: nowTimestamp()
    });
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error(JSON.stringify({ message: 'failed to record relay Accept', error: String(error) }));
    return jsonError(500, String(error));
  }
}

async function inbox(request: Request, env: WorkerEnv): Promise<Response> {
  let body: Uint8Array;
  let activity: Activity;
  try {
    body = new Uint8Array(await request.arrayBuffer());
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!isRecord(parsed)) throw new Error('activity must be a JSON object');
    activity = parsed;
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }

  const userAgent = request.headers.get('User-Agent') ?? '';
  if (isRelayUserAgent(userAgent) && activity.type !== 'Accept') {
    return writeForbiddenRelayResponse(request, userAgent);
  }
  if (
    !Object.hasOwn(activity, '@context')
    || typeof activity.type !== 'string'
    || typeof activity.actor !== 'string'
  ) {
    return jsonError(400, 'Invalid activity: missing required fields');
  }
  const validActivity: RequiredActivity = {
    ...activity,
    '@context': activity['@context'],
    type: activity.type,
    actor: activity.actor
  };

  if (validActivity.type === 'Delete') {
    return handleDelete(request, env, body, validActivity);
  }

  let actorInfo: RemoteActor;
  try {
    actorInfo = await fetchActor(validActivity.actor);
  } catch {
    return plainResponse(400, 'Could not fetch actor information');
  }
  try {
    await verifyHTTPRequest(request, body, actorInfo.publicKey.publicKeyPem);
  } catch {
    return plainResponse(401, 'Invalid HTTP Signature');
  }

  switch (validActivity.type) {
    case 'Follow':
      return handleFollow(request, env, validActivity, actorInfo);
    case 'Undo':
      return handleUndo(request, env, validActivity, actorInfo);
    case 'Accept':
      return handleAccept(env, validActivity, actorInfo);
    default:
      if (acknowledgedActivityTypes.has(validActivity.type)) return new Response(null, { status: 202 });
      return plainResponse(422, `${validActivity.type} activity is not supported`);
  }
}

export async function handleActivityPubRequest(
  request: Request,
  env: WorkerEnv,
  path: string
): Promise<Response | undefined> {
  if (request.method === 'GET' && path === '/.well-known/webfinger') return webfinger(request, env);
  if (request.method === 'GET' && path === '/.well-known/nodeinfo') {
    return jsonResponse({ links: [
      { rel: nodeInfoRel21, href: `${siteBaseURL(env)}/nodeinfo/2.1` },
      { rel: nodeInfoRel20, href: `${siteBaseURL(env)}/nodeinfo/2.0` }
    ] });
  }
  if (request.method === 'GET' && path === '/nodeinfo/2.0') return nodeInfo('2.0');
  if (request.method === 'GET' && path === '/nodeinfo/2.1') return nodeInfo('2.1');
  if (request.method === 'GET' && path === '/actor') return actor(request, env);
  if (request.method === 'GET' && path === '/actor/followers') return followers(request, env);
  if (request.method === 'GET' && path === '/actor/following') return following(request, env);
  if (request.method === 'GET' && path === '/actor/outbox') return outbox(request, env);
  if (request.method === 'POST' && path === '/actor/inbox') return inbox(request, env);
  const articleMatch = request.method === 'GET' ? /^\/api\/articles\/([^/]+)$/.exec(path) : null;
  const encodedArticleID = articleMatch?.[1];
  if (encodedArticleID !== undefined) {
    try {
      return articleNote(request, decodeURIComponent(encodedArticleID), env);
    } catch {
      return plainResponse(400, 'Invalid article name');
    }
  }
  return undefined;
}
