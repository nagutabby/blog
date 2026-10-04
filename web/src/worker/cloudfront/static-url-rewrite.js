// @ts-nocheck CloudFront Functions provide the event object at runtime.
function handler(event) {
  var request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;

  var uri = request.uri;
  if (uri === '/') {
    request.uri = '/index.html';
    return request;
  }

  if (uri.charAt(uri.length - 1) === '/') uri = uri.substring(0, uri.length - 1);
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) request.uri = uri + '.html';
  return request;
}
