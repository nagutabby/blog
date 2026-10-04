import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';

export interface Follower {
  id: number;
  actorId: string;
  inbox: string;
  publicKeyPem: string;
  following: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RelayConnection {
  id: number;
  actorId: string;
  inbox: string;
  connected: boolean;
  lastAcceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogDatabase {
  countActiveFollowers(): Promise<number>;
  listActiveFollowerActorIDs(limit: number, offset: number): Promise<string[]>;
  getFollowerByActorID(actorID: string): Promise<Follower | null>;
  upsertFollower(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void>;
  unfollowByActorID(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void>;
  countConnectedRelayConnections(): Promise<number>;
  listConnectedRelayActorIDs(limit: number, offset: number): Promise<string[]>;
  listConnectedRelayConnections(): Promise<RelayConnection[]>;
  upsertRelayConnectionAccepted(params: { actorId: string; inbox: string; now: string }): Promise<void>;
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'ap-northeast-1'
}), {
  marshallOptions: { removeUndefinedValues: true }
});

const followerIndex = 'following-state-id-index';
const relayIndex = 'connected-state-id-index';
const counterActorID = '__blog_counter__';

function stateKey(id: number): string {
  return String(id).padStart(20, '0');
}

async function nextID(client: DynamoDBDocumentClient, tableName: string): Promise<number> {
  const result = await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { actorId: counterActorID },
    UpdateExpression: 'SET #id = if_not_exists(#id, :zero) + :one',
    ExpressionAttributeNames: { '#id': 'id' },
    ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    ReturnValues: 'UPDATED_NEW'
  }));
  return Number(result.Attributes?.id);
}

async function countByState(client: DynamoDBDocumentClient, tableName: string, indexName: string, state: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#state = :state',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': state },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey
    }));
    count += result.Count ?? 0;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

async function actorIDsByState(
  client: DynamoDBDocumentClient,
  tableName: string,
  indexName: string,
  state: string,
  limit: number,
  offset: number
): Promise<string[]> {
  if (limit <= 0 || offset < 0) return [];
  const targetCount = offset + limit;
  const items: Array<{ actorId: string }> = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#state = :state',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': state },
      ProjectionExpression: 'actorId',
      Limit: Math.min(targetCount - items.length, 1000),
      ExclusiveStartKey: lastKey
    }));
    items.push(...(result.Items as Array<{ actorId: string }> | undefined ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (items.length < targetCount && lastKey);
  return items.slice(offset, targetCount).map(({ actorId }) => actorId);
}

async function allByState<T>(client: DynamoDBDocumentClient, tableName: string, indexName: string, state: string): Promise<T[]> {
  const items: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: '#state = :state',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':state': state },
      ExclusiveStartKey: lastKey
    }));
    items.push(...(result.Items as T[] | undefined ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export class DynamoBlogDatabase implements BlogDatabase {
  constructor(
    private readonly followerTable: string,
    private readonly relayTable: string,
    private readonly client: DynamoDBDocumentClient = dynamo
  ) {}

  countActiveFollowers(): Promise<number> {
    return countByState(this.client, this.followerTable, followerIndex, 'ACTIVE');
  }

  listActiveFollowerActorIDs(limit: number, offset: number): Promise<string[]> {
    return actorIDsByState(this.client, this.followerTable, followerIndex, 'ACTIVE', limit, offset);
  }

  async getFollowerByActorID(actorID: string): Promise<Follower | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.followerTable,
      Key: { actorId: actorID },
      ConsistentRead: true
    }));
    return result.Item && !('state' in result.Item) ? null : (result.Item as Follower | undefined) ?? null;
  }

  async upsertFollower(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    const existing = await this.getFollowerByActorID(params.actorId);
    if (existing) {
      await this.client.send(new UpdateCommand({
        TableName: this.followerTable,
        Key: { actorId: params.actorId },
        UpdateExpression: 'SET inbox = :inbox, publicKeyPem = :publicKeyPem, following = :following, #state = :state, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':inbox': params.inbox,
          ':publicKeyPem': params.publicKeyPem,
          ':following': true,
          ':state': 'ACTIVE',
          ':updatedAt': params.now
        }
      }));
      return;
    }

    const id = await nextID(this.client, this.followerTable);
    const item = {
      ...params,
      id,
      following: true,
      state: 'ACTIVE',
      orderKey: stateKey(id),
      createdAt: params.now,
      updatedAt: params.now
    };
    try {
      await this.client.send(new PutCommand({
        TableName: this.followerTable,
        Item: item,
        ConditionExpression: 'attribute_not_exists(actorId)'
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      await this.upsertFollower(params);
    }
  }

  async unfollowByActorID(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.followerTable,
        Key: { actorId: params.actorId },
        UpdateExpression: 'SET inbox = :inbox, publicKeyPem = :publicKeyPem, following = :following, #state = :state, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(actorId)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':inbox': params.inbox,
          ':publicKeyPem': params.publicKeyPem,
          ':following': false,
          ':state': 'INACTIVE',
          ':updatedAt': params.now
        }
      }));
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new Error('follower not found');
      throw error;
    }
  }

  countConnectedRelayConnections(): Promise<number> {
    return countByState(this.client, this.relayTable, relayIndex, 'CONNECTED');
  }

  listConnectedRelayActorIDs(limit: number, offset: number): Promise<string[]> {
    return actorIDsByState(this.client, this.relayTable, relayIndex, 'CONNECTED', limit, offset);
  }

  listConnectedRelayConnections(): Promise<RelayConnection[]> {
    return allByState<RelayConnection>(this.client, this.relayTable, relayIndex, 'CONNECTED');
  }

  async upsertRelayConnectionAccepted(params: { actorId: string; inbox: string; now: string }): Promise<void> {
    const existing = await this.client.send(new GetCommand({
      TableName: this.relayTable,
      Key: { actorId: params.actorId },
      ConsistentRead: true
    }));
    if (existing.Item && 'state' in existing.Item) {
      await this.client.send(new UpdateCommand({
        TableName: this.relayTable,
        Key: { actorId: params.actorId },
        UpdateExpression: 'SET inbox = :inbox, connected = :connected, #state = :state, lastAcceptedAt = :lastAcceptedAt, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':inbox': params.inbox,
          ':connected': true,
          ':state': 'CONNECTED',
          ':lastAcceptedAt': params.now,
          ':updatedAt': params.now
        }
      }));
      return;
    }

    const id = await nextID(this.client, this.relayTable);
    try {
      await this.client.send(new PutCommand({
        TableName: this.relayTable,
        Item: {
          ...params,
          id,
          connected: true,
          state: 'CONNECTED',
          orderKey: stateKey(id),
          lastAcceptedAt: params.now,
          createdAt: params.now,
          updatedAt: params.now
        },
        ConditionExpression: 'attribute_not_exists(actorId)'
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      await this.upsertRelayConnectionAccepted(params);
    }
  }
}

export function createDynamoBlogDatabase(): DynamoBlogDatabase {
  const followerTable = process.env.FOLLOWER_TABLE;
  const relayTable = process.env.RELAY_TABLE;
  if (!followerTable || !relayTable) throw new Error('FOLLOWER_TABLE and RELAY_TABLE are required');
  return new DynamoBlogDatabase(followerTable, relayTable);
}

export class D1BlogDatabase implements BlogDatabase {
  constructor(private readonly database: D1Database) {}

  async countActiveFollowers(): Promise<number> {
    const result = await this.database
      .prepare('SELECT count(*) AS count FROM "Follower" WHERE "following" = 1')
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  async listActiveFollowerActorIDs(limit: number, offset: number): Promise<string[]> {
    const result = await this.database
      .prepare('SELECT "actorId" FROM "Follower" WHERE "following" = 1 ORDER BY "id" LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<{ actorId: string }>();
    return result.results.map(({ actorId }) => actorId);
  }

  async getFollowerByActorID(actorID: string): Promise<Follower | null> {
    return await this.database
      .prepare('SELECT * FROM "Follower" WHERE "actorId" = ?')
      .bind(actorID)
      .first<Follower>() ?? null;
  }

  async upsertFollower(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    await this.database.prepare(
      `INSERT INTO "Follower" ("actorId", "inbox", "publicKeyPem", "following", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT ("actorId") DO UPDATE SET
         "following" = 1, "inbox" = excluded."inbox", "publicKeyPem" = excluded."publicKeyPem", "updatedAt" = excluded."updatedAt"`
    ).bind(params.actorId, params.inbox, params.publicKeyPem, params.now, params.now).run();
  }

  async unfollowByActorID(params: Pick<Follower, 'actorId' | 'inbox' | 'publicKeyPem'> & { now: string }): Promise<void> {
    const result = await this.database.prepare(
      `UPDATE "Follower" SET "following" = 0, "inbox" = ?, "publicKeyPem" = ?, "updatedAt" = ? WHERE "actorId" = ?`
    ).bind(params.inbox, params.publicKeyPem, params.now, params.actorId).run();
    if ((result.meta.changes ?? 0) === 0) throw new Error('follower not found');
  }

  async countConnectedRelayConnections(): Promise<number> {
    const result = await this.database
      .prepare('SELECT count(*) AS count FROM "RelayConnection" WHERE "connected" = 1')
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  async listConnectedRelayActorIDs(limit: number, offset: number): Promise<string[]> {
    const result = await this.database
      .prepare('SELECT "actorId" FROM "RelayConnection" WHERE "connected" = 1 ORDER BY "id" LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all<{ actorId: string }>();
    return result.results.map(({ actorId }) => actorId);
  }

  async listConnectedRelayConnections(): Promise<RelayConnection[]> {
    const result = await this.database
      .prepare('SELECT * FROM "RelayConnection" WHERE "connected" = 1 ORDER BY "id"')
      .all<RelayConnection>();
    return result.results;
  }

  async upsertRelayConnectionAccepted(params: { actorId: string; inbox: string; now: string }): Promise<void> {
    await this.database.prepare(
      `INSERT INTO "RelayConnection" ("actorId", "inbox", "connected", "lastAcceptedAt", "createdAt", "updatedAt")
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT ("actorId") DO UPDATE SET
         "connected" = 1, "inbox" = excluded."inbox", "lastAcceptedAt" = excluded."lastAcceptedAt", "updatedAt" = excluded."updatedAt"`
    ).bind(params.actorId, params.inbox, params.now, params.now, params.now).run();
  }
}
