import { articleNotificationApp } from './article-notification';
import { loadFederationAdminEnv, toLambdaResponse, toRequest, type HttpApiV2Event, type HttpApiV2Response } from './lambda';

export async function handler(event: HttpApiV2Event): Promise<HttpApiV2Response> {
  try {
    return await toLambdaResponse(await articleNotificationApp.fetch(toRequest(event), await loadFederationAdminEnv()));
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Article notification request failed',
      error: error instanceof Error ? error.message : String(error)
    }));
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"Service unavailable"}',
      isBase64Encoded: false
    };
  }
}
