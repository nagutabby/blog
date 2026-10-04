import type { BlogDatabase } from './db';

export interface WorkerEnv {
  DB: BlogDatabase;
  SITE_BASE_URL: string;
  ACTOR_PUBLIC_KEY_PEM: string;
  ACTOR_PRIVATE_KEY_PEM: string;
  FEDERATION_ADMIN_TOKEN: string;
  EMAIL_API_TOKEN: string;
  FROM_ADDRESS: string;
  BCC_ADDRESS: string;
}

export type FederationAdminEnv = Pick<
  WorkerEnv,
  'DB' | 'SITE_BASE_URL' | 'ACTOR_PRIVATE_KEY_PEM' | 'FEDERATION_ADMIN_TOKEN'
>;
