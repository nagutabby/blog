import { createRequire } from 'node:module';

const apiEndpoint = process.env.API_GATEWAY_ENDPOINT;
const notificationEndpoint = process.env.ARTICLE_NOTIFICATION_API_ENDPOINT;
if (!apiEndpoint || !notificationEndpoint) {
  throw new Error('Set API_GATEWAY_ENDPOINT and ARTICLE_NOTIFICATION_API_ENDPOINT from the Blog stack outputs.');
}

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { GetSecretValueCommand, SecretsManagerClient } = requireFromWeb('@aws-sdk/client-secrets-manager');
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
const originSecretId = process.env.ORIGIN_HEADER_SECRET ?? 'blog/cloudfront-origin-header';
const secretResponse = await secretsClient.send(new GetSecretValueCommand({ SecretId: originSecretId }));
const originHeader = secretResponse.SecretString;
if (!originHeader) throw new Error('The origin verification secret is missing.');

const originHeaders = { 'X-Blog-Origin-Verify': originHeader };
const apiURL = (path) => new URL(path, apiEndpoint).toString();

async function request(name, url, expectedStatus, headers = originHeaders, method = 'GET') {
  const response = await fetch(url, {
    method,
    headers,
    ...(method === 'POST' ? { body: '{}' } : {})
  });
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(`${name} returned ${response.status}; expected ${expectedStatus}.`);
  }
  console.log(`${name}: ${response.status}`);
  return response;
}

await request('Direct API without origin header', apiURL('/healthz'), 403, {});
const health = await request('Health endpoint', apiURL('/healthz'), 200);
if ((await health.text()) !== 'ok') throw new Error('Health endpoint returned an unexpected body.');

const webfinger = await request(
  'ActivityPub WebFinger',
  apiURL('/.well-known/webfinger?resource=acct%3Aarticle%40blog.app.nagutabby.uk'),
  200
).then((response) => response.json());
if (webfinger.subject !== 'acct:article@blog.app.nagutabby.uk') {
  throw new Error('WebFinger returned an unexpected subject.');
}

const nodeInfo = await request('ActivityPub NodeInfo', apiURL('/nodeinfo/2.1'), 200)
  .then((response) => response.json());
if (nodeInfo.software?.name !== 'blog' || nodeInfo.software?.repository !== 'https://github.com/nagutabby/blog') {
  throw new Error('NodeInfo does not contain the new application identity.');
}

const actor = await request('ActivityPub actor', apiURL('/actor'), 200)
  .then((response) => response.json());
if (actor.id !== 'https://blog.app.nagutabby.uk/actor' || !actor.publicKey?.publicKeyPem?.includes('BEGIN PUBLIC KEY')) {
  throw new Error('The actor document or preserved public key is invalid.');
}

for (const path of ['/actor/followers', '/actor/following']) {
  const collection = await request(`ActivityPub ${path}`, apiURL(path), 200)
    .then((response) => response.json());
  if (!Number.isInteger(collection.totalItems) || collection.totalItems < 0) {
    throw new Error(`${path} did not return a valid DynamoDB-backed collection count.`);
  }
}

await request('Article notification API without bearer token', notificationEndpoint, 401, {
  'content-type': 'application/json'
}, 'POST');
