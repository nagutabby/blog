// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoBlogDatabase } from './db';

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function databaseWithSend(send: (command: CommandLike) => Promise<unknown>): DynamoBlogDatabase {
  return new DynamoBlogDatabase('followers', 'relays', { send } as unknown as DynamoDBDocumentClient);
}

describe('DynamoDB blog repository', () => {
  it('updates follower and relay state when records already exist', async () => {
    const follower = {
      actorId: 'https://social.example/follower',
      id: 7,
      state: 'INACTIVE'
    };
    const relay = {
      actorId: 'https://social.example/relay',
      id: 9,
      state: 'DISCONNECTED'
    };
    const send = vi.fn(async (command: CommandLike) => {
      if (command.constructor.name === 'GetCommand') {
        return { Item: command.input.TableName === 'followers' ? follower : relay };
      }
      if (command.constructor.name === 'UpdateCommand') return {};
      throw new Error(`Unexpected DynamoDB command: ${command.constructor.name}`);
    });
    const db = databaseWithSend(send);

    await db.upsertFollower({
      actorId: follower.actorId,
      inbox: 'https://social.example/follower/inbox',
      publicKeyPem: 'public-key',
      now: '2026-10-04T00:00:00.000Z'
    });
    await db.upsertRelayConnectionAccepted({
      actorId: relay.actorId,
      inbox: 'https://social.example/relay/inbox',
      now: '2026-10-04T00:01:00.000Z'
    });

    const updates = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === 'UpdateCommand')
      .map((command) => command.input);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      TableName: 'followers',
      ExpressionAttributeValues: expect.objectContaining({ ':following': true, ':state': 'ACTIVE' })
    });
    expect(updates[1]).toMatchObject({
      TableName: 'relays',
      ExpressionAttributeValues: expect.objectContaining({ ':connected': true, ':state': 'CONNECTED' })
    });
  });

  it('paginates state-index queries and applies follower offsets', async () => {
    const send = vi.fn(async (command: CommandLike) => {
      expect(command.constructor.name).toBe('QueryCommand');
      if (command.input.TableName === 'followers') {
        if (!command.input.ExclusiveStartKey) {
          return {
            Items: [{ actorId: 'follower-1' }, { actorId: 'follower-2' }],
            LastEvaluatedKey: { actorId: 'follower-2' }
          };
        }
        return { Items: [{ actorId: 'follower-3' }, { actorId: 'follower-4' }] };
      }
      if (!command.input.ExclusiveStartKey) {
        return {
          Items: [{ actorId: 'relay-1', connected: true }, { actorId: 'relay-2', connected: true }],
          LastEvaluatedKey: { actorId: 'relay-2' }
        };
      }
      return { Items: [{ actorId: 'relay-3', connected: true }] };
    });
    const db = databaseWithSend(send);

    await expect(db.listActiveFollowerActorIDs(2, 1)).resolves.toEqual(['follower-2', 'follower-3']);
    await expect(db.listConnectedRelayConnections()).resolves.toEqual([
      { actorId: 'relay-1', connected: true },
      { actorId: 'relay-2', connected: true },
      { actorId: 'relay-3', connected: true }
    ]);

    const followerQueries = send.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input.TableName === 'followers');
    expect(followerQueries).toHaveLength(2);
    expect(followerQueries[0]).toMatchObject({
      IndexName: 'following-state-id-index',
      ExpressionAttributeValues: { ':state': 'ACTIVE' },
      Limit: 3
    });
    expect(followerQueries[1]).toMatchObject({
      ExclusiveStartKey: { actorId: 'follower-2' },
      Limit: 1
    });

    const relayQueries = send.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input.TableName === 'relays');
    expect(relayQueries).toHaveLength(2);
    expect(relayQueries.every((input) =>
      input.IndexName === 'connected-state-id-index' &&
      (input.ExpressionAttributeValues as Record<string, unknown>)[':state'] === 'CONNECTED'
    )).toBe(true);
  });
});
