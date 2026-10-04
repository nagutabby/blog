import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { app } from './index';
import { createDynamoBlogDatabase } from './db';
import type { FederationAdminEnv, WorkerEnv } from './bindings';

export interface HttpApiV2Event {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    domainName?: string;
    http: { method: string };
  };
}

export interface HttpApiV2Response {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: false;
}

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
const secretCache = new Map<string, Promise<string>>();

function readSecret(secretId: string): Promise<string> {
  const cached = secretCache.get(secretId);
  if (cached) return cached;
  const value = secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }))
    .then((result) => {
      if (!result.SecretString) throw new Error('SecretString is missing');
      return result.SecretString;
    });
  secretCache.set(secretId, value);
  return value;
}

let runtimeEnv: Promise<WorkerEnv> | undefined;
let federationAdminEnv: Promise<FederationAdminEnv> | undefined;

export async function loadRuntimeEnv(): Promise<WorkerEnv> {
  if (!runtimeEnv) {
    runtimeEnv = readSecret(process.env.RUNTIME_SECRET_ARN ?? '')
      .then((secret) => {
        const values = JSON.parse(secret) as Partial<WorkerEnv>;
        for (const name of [
          'ACTOR_PUBLIC_KEY_PEM',
          'ACTOR_PRIVATE_KEY_PEM',
          'FEDERATION_ADMIN_TOKEN',
          'EMAIL_API_TOKEN',
          'FROM_ADDRESS',
          'BCC_ADDRESS'
        ] as const) {
          if (typeof values[name] !== 'string' || !values[name]) throw new Error(`Missing runtime secret: ${name}`);
        }
        return {
          DB: createDynamoBlogDatabase(),
          SITE_BASE_URL: process.env.SITE_BASE_URL ?? 'https://blog.app.nagutabby.uk',
          ACTOR_PUBLIC_KEY_PEM: values.ACTOR_PUBLIC_KEY_PEM!,
          ACTOR_PRIVATE_KEY_PEM: values.ACTOR_PRIVATE_KEY_PEM!,
          FEDERATION_ADMIN_TOKEN: values.FEDERATION_ADMIN_TOKEN!,
          EMAIL_API_TOKEN: values.EMAIL_API_TOKEN!,
          FROM_ADDRESS: values.FROM_ADDRESS!,
          BCC_ADDRESS: values.BCC_ADDRESS!
        };
      })
      .catch((error: unknown) => {
        runtimeEnv = undefined;
        throw error;
      });
  }
  return runtimeEnv;
}

export async function loadFederationAdminEnv(): Promise<FederationAdminEnv> {
  if (!federationAdminEnv) {
    federationAdminEnv = readSecret(process.env.RUNTIME_SECRET_ARN ?? '')
      .then((secret) => {
        const values = JSON.parse(secret) as Partial<WorkerEnv>;
        for (const name of ['ACTOR_PRIVATE_KEY_PEM', 'FEDERATION_ADMIN_TOKEN'] as const) {
          if (typeof values[name] !== 'string' || !values[name]) throw new Error(`Missing runtime secret: ${name}`);
        }
        return {
          DB: createDynamoBlogDatabase(),
          SITE_BASE_URL: process.env.SITE_BASE_URL ?? 'https://blog.app.nagutabby.uk',
          ACTOR_PRIVATE_KEY_PEM: values.ACTOR_PRIVATE_KEY_PEM!,
          FEDERATION_ADMIN_TOKEN: values.FEDERATION_ADMIN_TOKEN!
        };
      })
      .catch((error: unknown) => {
        federationAdminEnv = undefined;
        throw error;
      });
  }
  return federationAdminEnv;
}

function header(event: HttpApiV2Event, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === target) return value ?? '';
  }
  return '';
}

async function isFromCloudFront(event: HttpApiV2Event): Promise<boolean> {
  const secretArn = process.env.ORIGIN_HEADER_SECRET_ARN;
  if (!secretArn) return false;
  const expected = await readSecret(secretArn);
  const provided = header(event, 'x-blog-origin-verify');
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function toRequest(event: HttpApiV2Event): Request {
  const path = event.rawPath || '/';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const host = event.requestContext.domainName || 'localhost';
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies?.length && !headers.has('cookie')) headers.set('cookie', event.cookies.join('; '));
  let body: BodyInit | undefined;
  if (event.body !== undefined && event.requestContext.http.method !== 'GET' && event.requestContext.http.method !== 'HEAD') {
    body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;
  }
  return new Request(`https://${host}${path}${query}`, {
    method: event.requestContext.http.method,
    headers,
    ...(body === undefined ? {} : { body })
  });
}

export function toLambdaResponse(response: Response): Promise<HttpApiV2Response> {
  return response.arrayBuffer().then((bytes) => {
  const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
    }
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = getSetCookie?.call(response.headers) ?? [];
    return {
      statusCode: response.status,
      headers,
      ...(cookies.length ? { cookies } : {}),
      body: new TextDecoder().decode(bytes),
      isBase64Encoded: false
    };
  });
}

export async function handler(event: HttpApiV2Event): Promise<HttpApiV2Response> {
  try {
    if (!await isFromCloudFront(event)) {
      return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Forbidden', isBase64Encoded: false };
    }
    const request = toRequest(event);
    return await toLambdaResponse(await app.fetch(request, await loadRuntimeEnv()));
  } catch (error) {
    console.error(JSON.stringify({ message: 'Lambda request failed', error: error instanceof Error ? error.message : String(error) }));
    return { statusCode: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"Service unavailable"}', isBase64Encoded: false };
  }
}
