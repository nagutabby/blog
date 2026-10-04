import type { WorkerEnv } from './bindings';
import type { BlogDatabase, Follower, RelayConnection } from './db';

export const siteBaseURL = 'https://blog.app.nagutabby.uk';

export class FakeBlogDatabase implements BlogDatabase {
  readonly followers = new Map<string, Follower>();
  readonly relayConnections = new Map<string, RelayConnection>();
  failQueries = false;

  private failIfRequested(): void {
    if (this.failQueries) throw new Error('simulated DynamoDB failure');
  }

  async countActiveFollowers(): Promise<number> {
    this.failIfRequested();
    return [...this.followers.values()].filter((row) => row.following).length;
  }

  async listActiveFollowerActorIDs(limit: number, offset: number): Promise<string[]> {
    this.failIfRequested();
    return [...this.followers.values()]
      .filter((row) => row.following)
      .sort((left, right) => left.id - right.id)
      .slice(offset, offset + limit)
      .map(({ actorId }) => actorId);
  }

  async getFollowerByActorID(actorID: string): Promise<Follower | null> {
    this.failIfRequested();
    return this.followers.get(actorID) ?? null;
  }

  async upsertFollower(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    this.failIfRequested();
    const existing = this.followers.get(params.actorId);
    this.followers.set(params.actorId, {
      id: existing?.id ?? Math.max(0, ...[...this.followers.values()].map((row) => row.id)) + 1,
      actorId: params.actorId,
      inbox: params.inbox,
      publicKeyPem: params.publicKeyPem,
      following: true,
      createdAt: existing?.createdAt ?? params.now,
      updatedAt: params.now
    });
  }

  async unfollowByActorID(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    this.failIfRequested();
    const existing = this.followers.get(params.actorId);
    if (!existing) throw new Error('follower not found');
    this.followers.set(params.actorId, {
      ...existing,
      inbox: params.inbox,
      publicKeyPem: params.publicKeyPem,
      following: false,
      updatedAt: params.now
    });
  }

  async countConnectedRelayConnections(): Promise<number> {
    this.failIfRequested();
    return [...this.relayConnections.values()].filter((row) => row.connected).length;
  }

  async listConnectedRelayActorIDs(limit: number, offset: number): Promise<string[]> {
    this.failIfRequested();
    return [...this.relayConnections.values()]
      .filter((row) => row.connected)
      .sort((left, right) => left.id - right.id)
      .slice(offset, offset + limit)
      .map(({ actorId }) => actorId);
  }

  async listConnectedRelayConnections(): Promise<RelayConnection[]> {
    this.failIfRequested();
    return [...this.relayConnections.values()]
      .filter((row) => row.connected)
      .sort((left, right) => left.id - right.id);
  }

  async upsertRelayConnectionAccepted(params: { actorId: string; inbox: string; now: string }): Promise<void> {
    this.failIfRequested();
    const existing = this.relayConnections.get(params.actorId);
    this.relayConnections.set(params.actorId, {
      id: existing?.id ?? Math.max(0, ...[...this.relayConnections.values()].map((row) => row.id)) + 1,
      actorId: params.actorId,
      inbox: params.inbox,
      connected: true,
      lastAcceptedAt: params.now,
      createdAt: existing?.createdAt ?? params.now,
      updatedAt: params.now
    });
  }
}

export function makeWorkerEnv(db = new FakeBlogDatabase()): WorkerEnv {
  return {
    DB: db,
    SITE_BASE_URL: siteBaseURL,
    ACTOR_PUBLIC_KEY_PEM: '',
    ACTOR_PRIVATE_KEY_PEM: '',
    FEDERATION_ADMIN_TOKEN: 'test-admin-token',
    EMAIL_API_TOKEN: 'test-email-token',
    FROM_ADDRESS: 'from@example.com',
    BCC_ADDRESS: 'bcc@example.com'
  };
}

export function seedFollower(db: FakeBlogDatabase, actorId: string, publicKeyPem: string): Follower {
  const follower: Follower = {
    id: db.followers.size + 1,
    actorId,
    inbox: `${new URL(actorId).origin}/inbox`,
    publicKeyPem,
    following: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  db.followers.set(actorId, follower);
  return follower;
}
