import { Hono } from 'hono';
import { federationAdminRoutes } from './rpc';
import type { FederationAdminEnv } from './bindings';

const articleNotificationApp = new Hono<{ Bindings: FederationAdminEnv }>()
  .route('/rpc/federation-admin', federationAdminRoutes);

export { articleNotificationApp };
