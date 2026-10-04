// @ts-nocheck CloudFront Functions provide the event object at runtime.
function handler(event) {
  var request = event.request;
  if (request.method === 'POST' && request.uri === '/actor/inbox') {
    return {
      statusCode: 403,
      statusDescription: 'Forbidden',
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'text/plain; charset=utf-8' }
      },
      body: 'Forbidden'
    };
  }
  return request;
}
