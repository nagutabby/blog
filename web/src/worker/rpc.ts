import { Hono, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getArticle } from './content';
import { constantTimeTokenMatches, signActivity, signHTTPRequest } from './crypto';
import type { FederationAdminEnv, WorkerEnv } from './bindings';

const contactRoutes = new Hono<{ Bindings: WorkerEnv }>().post(
  '/submit',
  zValidator('json', z.object({
    name: z.string(),
    email: z.string(),
    text: z.string(),
    imRobot: z.boolean().optional().default(false)
  })),
  async (context) => {
    const message = context.req.valid('json');
    const errors: Record<string, string> = {};
    if (message.imRobot) errors.imRobot = 'Botによるメッセージ送信はできません';
    if (message.name === '') errors.name = '氏名は必須です';
    if (message.email === '') errors.email = 'メールアドレスは必須です';
    else if (!/^[a-zA-Z0-9_+-]+(\.[a-zA-Z0-9_+-]+)*@([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]\.)+[a-zA-Z]{2,}$/.test(message.email)) {
      errors.email = 'メールアドレスの形式が不適切です';
    }
    if (message.text === '') errors.text = '本文は必須です';
    if (Object.keys(errors).length) return context.json({ errors }, 200);

    const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&#34;',
      "'": '&#39;'
    })[character] ?? character);

    const payload = {
      from: { email: context.env.FROM_ADDRESS, name: 'Hiroto Sasagawa' },
      to: [{ email: message.email, name: message.name }],
      bcc: [{ email: context.env.BCC_ADDRESS, name: 'Hiroto Sasagawa' }],
      subject: 'お問い合わせを受け付けました',
      html: `<!DOCTYPE HTML><html><p>お問い合わせ内容は以下の通りです。</p><ul><li>氏名: ${escapeHTML(message.name)}</li><li>メールアドレス: ${escapeHTML(message.email)}</li><li>本文: ${escapeHTML(message.text)}</li></ul><p>返信まで数日かかる場合がございます。予めご了承ください。</p></html>`
    };

    let response: Response;
    try {
      response = await fetch('https://send.api.mailtrap.io/api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Token': context.env.EMAIL_API_TOKEN
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.error(JSON.stringify({ message: 'Mailtrap request failed', error: String(error) }));
      return context.json({ error: 'Contact delivery failed' }, 503);
    }
    if (!response.ok) {
      console.error(JSON.stringify({ message: 'Mailtrap API returned an error', status: response.status }));
      await response.body?.cancel();
      return context.json({ error: 'Contact delivery failed' }, 503);
    }
    await response.body?.cancel();
    return context.json({ errors: {} }, 200);
  }
);

const federationAdminAuth: MiddlewareHandler<{ Bindings: FederationAdminEnv }> = async (context, next) => {
  const expected = context.env.FEDERATION_ADMIN_TOKEN || '';
  const authorization = context.req.header('Authorization') ?? '';
  const hasBearerScheme = authorization.startsWith('Bearer ');
  const provided = hasBearerScheme ? authorization.slice('Bearer '.length) : '';
  if (!expected || !hasBearerScheme || !(await constantTimeTokenMatches(provided, expected))) {
    return context.json({ error: 'Unauthorized' }, 401);
  }
  return next();
};

export const federationAdminRoutes = new Hono<{ Bindings: FederationAdminEnv }>()
  .use('/publish-article-activity', federationAdminAuth)
  .post(
    '/publish-article-activity',
    zValidator('json', z.object({
      articleId: z.string().min(1),
      changeType: z.enum(['create', 'update', 'delete'])
    })),
    async (context) => {
      const { articleId, changeType } = context.req.valid('json');
      const base = (context.env.SITE_BASE_URL || 'https://blog.app.nagutabby.uk').replace(/\/$/, '');
      let object: Record<string, unknown>;
      let type: 'Create' | 'Update' | 'Delete';
      let suffix: string;

      if (changeType === 'delete') {
        type = 'Delete';
        suffix = 'delete';
        object = { id: `${base}/api/articles/${articleId}`, type: 'Note' };
      } else {
        const article = getArticle(articleId);
        if (!article) return context.json({ error: 'Article not found' }, 500);
        type = changeType === 'create' ? 'Create' : 'Update';
        suffix = changeType;
        const articleURL = `${base}/api/articles/${articleId}`;
        object = {
          id: articleURL,
          type: 'Note',
          attributedTo: `${base}/actor`,
          name: article.title,
          content: `<p>${article.title}</p><a href="${base}/articles/${articleId}" target="_blank">${base}/articles/${articleId}</a>`,
          published: article.publishedAt.toISOString().slice(0, 23) + 'Z',
          url: articleURL,
          to: ['https://www.w3.org/ns/activitystreams#Public']
        };
      }

      const activityBase = {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: `${base}/api/articles/${articleId}/${suffix}`,
        type,
        actor: `${base}/actor`,
        published: new Date().toISOString().slice(0, 23) + 'Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object
      };

      try {
        const signature = await signActivity(activityBase, context.env.ACTOR_PRIVATE_KEY_PEM || '');
        const activity = { ...activityBase, signature };
        const body = JSON.stringify(activity);
        const relays = await context.env.DB.listConnectedRelayConnections();
        for (const relay of relays) {
          try {
            const headers = await signHTTPRequest(
              relay.inbox,
              'POST',
              body,
              `${base}/actor#main-key`,
              context.env.ACTOR_PRIVATE_KEY_PEM || ''
            );
            const response = await fetch(relay.inbox, {
              method: 'POST',
              headers: {
                Date: headers.date,
                Digest: headers.digest,
                Signature: headers.signature,
                'Content-Type': 'application/activity+json',
                Accept: 'application/activity+json'
              },
              body
            });
            const status = response.status;
            await response.body?.cancel();
            if (!response.ok) throw new Error(`delivery returned ${status}`);
          } catch (error) {
            console.error(JSON.stringify({
              message: 'ActivityPub relay delivery failed',
              relay: relay.inbox,
              error: String(error)
            }));
          }
        }
        return context.json({}, 200);
      } catch (error) {
        console.error(JSON.stringify({ message: 'failed to publish ActivityPub activity', error: String(error) }));
        return context.json({ error: 'Activity publication failed' }, 500);
      }
    }
  );

const rpcRoutes = new Hono<{ Bindings: WorkerEnv }>()
  .route('/contact', contactRoutes);

export type RpcAppType = typeof rpcRoutes;
export { rpcRoutes };
