import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand
} = requireFromWeb('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = requireFromWeb('@aws-sdk/client-dynamodb');
const followerTable = process.env.FOLLOWER_TABLE ?? 'sveltekit-blog-followers';
const relayTable = process.env.RELAY_TABLE ?? 'sveltekit-blog-relay-connections';
const apply = process.argv.includes('--apply');
const backupArg = process.argv.indexOf('--backup');
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const backupPath = backupArg >= 0
  ? path.resolve(process.argv[backupArg + 1])
  : path.join(root, 'backend/migration-backups', `sveltekit-blog-d1-${timestamp}.sql`);

if (backupArg >= 0 && !process.argv[backupArg + 1]) throw new Error('--backup requires a file path');

function exportD1Backup() {
  mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  execFileSync('pnpm', [
    '--dir', 'web', 'exec', 'wrangler', 'd1', 'export', 'sveltekit-blog-db',
    '--remote',
    '--config', '../backend/wrangler.jsonc',
    '--table', 'Follower',
    '--table', 'RelayConnection',
    '--output', backupPath
  ], {
    cwd: root,
    stdio: ['inherit', 'ignore', 'inherit']
  });
  chmodSync(backupPath, 0o600);
}

function value(row, key) {
  if (row[key] === null || row[key] === undefined) return null;
  return row[key];
}

function loadSourceRecords() {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(backupPath, 'utf8'));
    const followers = database.prepare('SELECT * FROM "Follower" ORDER BY "id"').all().map((row) => ({
      id: Number(row.id),
      actorId: String(row.actorId),
      inbox: String(row.inbox),
      publicKeyPem: String(row.publicKeyPem),
      following: Boolean(Number(row.following)),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    }));
    const relays = database.prepare('SELECT * FROM "RelayConnection" ORDER BY "id"').all().map((row) => ({
      id: Number(row.id),
      actorId: String(row.actorId),
      inbox: String(row.inbox),
      connected: Boolean(Number(row.connected)),
      lastAcceptedAt: value(row, 'lastAcceptedAt') === null ? null : String(row.lastAcceptedAt),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt)
    }));
    return { followers, relays };
  } finally {
    database.close();
  }
}

function rowForDynamo(table, row) {
  const active = table === 'followers' ? row.following : row.connected;
  return {
    ...row,
    state: table === 'followers' ? (active ? 'ACTIVE' : 'INACTIVE') : (active ? 'CONNECTED' : 'DISCONNECTED'),
    orderKey: String(row.id).padStart(20, '0')
  };
}

function comparable(table, row) {
  if (table === 'followers') {
    return {
      id: Number(row.id), actorId: String(row.actorId), inbox: String(row.inbox),
      publicKeyPem: String(row.publicKeyPem), following: Boolean(row.following),
      createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
    };
  }
  return {
    id: Number(row.id), actorId: String(row.actorId), inbox: String(row.inbox),
    connected: Boolean(row.connected),
    lastAcceptedAt: row.lastAcceptedAt === null || row.lastAcceptedAt === undefined ? null : String(row.lastAcceptedAt),
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt)
  };
}

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function scanTable(client, tableName) {
  const items = [];
  let lastKey;
  do {
    const result = await client.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      ExclusiveStartKey: lastKey
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function assertTargetIsCompatible(table, sourceRows, targetRows) {
  const sourceByActor = new Map(sourceRows.map((row) => [row.actorId, row]));
  for (const item of targetRows) {
    if (item.actorId === '__blog_counter__') continue;
    const source = sourceByActor.get(item.actorId);
    assert.ok(source, `Target ${table} table contains a record absent from the D1 backup.`);
    assert.equal(
      stableJSON(comparable(table, item)),
      stableJSON(comparable(table, source)),
      `Target ${table} record differs from the D1 backup.`
    );
  }
}

async function batchPut(client, tableName, items) {
  for (let offset = 0; offset < items.length; offset += 25) {
    let pending = items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length && attempt < 8; attempt += 1) {
      const result = await client.send(new BatchWriteCommand({
        RequestItems: { [tableName]: pending }
      }));
      pending = result.UnprocessedItems?.[tableName] ?? [];
      if (pending.length) await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
    }
    assert.equal(pending.length, 0, `DynamoDB left unprocessed items in ${tableName}.`);
  }
}

async function countIndex(client, tableName, indexName, state) {
  let count = 0;
  let lastKey;
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

async function waitForIndexCounts(client, source) {
  const wanted = [
    [followerTable, 'following-state-id-index', 'ACTIVE', source.followers.filter((row) => row.following).length],
    [followerTable, 'following-state-id-index', 'INACTIVE', source.followers.filter((row) => !row.following).length],
    [relayTable, 'connected-state-id-index', 'CONNECTED', source.relays.filter((row) => row.connected).length],
    [relayTable, 'connected-state-id-index', 'DISCONNECTED', source.relays.filter((row) => !row.connected).length]
  ];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const counts = await Promise.all(wanted.map(([table, index, state]) => countIndex(client, table, index, state)));
    if (counts.every((count, index) => count === wanted[index][3])) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('DynamoDB state indexes did not reach the D1 record counts within 30 seconds.');
}

async function verifyTable(client, tableName, sourceRows, table) {
  const targetRows = (await scanTable(client, tableName)).filter((row) => row.actorId !== '__blog_counter__');
  assert.equal(targetRows.length, sourceRows.length, `The ${tableName} item count does not match D1.`);
  assertTargetIsCompatible(table, sourceRows, targetRows);
}

exportD1Backup();
const source = loadSourceRecords();
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'ap-northeast-1'
}), { marshallOptions: { removeUndefinedValues: true } });

console.log(`D1 backup: ${backupPath}`);
console.log(`Source rows: Follower=${source.followers.length} (following=${source.followers.filter((row) => row.following).length}), RelayConnection=${source.relays.length} (connected=${source.relays.filter((row) => row.connected).length})`);

if (apply) {
  const [targetFollowers, targetRelays] = await Promise.all([
    scanTable(dynamo, followerTable),
    scanTable(dynamo, relayTable)
  ]);
  assertTargetIsCompatible('followers', source.followers, targetFollowers);
  assertTargetIsCompatible('relays', source.relays, targetRelays);

  const followerActors = new Set(targetFollowers.map((row) => row.actorId));
  const relayActors = new Set(targetRelays.map((row) => row.actorId));
  await Promise.all([
    batchPut(dynamo, followerTable, source.followers
      .filter((row) => !followerActors.has(row.actorId))
      .map((row) => rowForDynamo('followers', row))),
    batchPut(dynamo, relayTable, source.relays
      .filter((row) => !relayActors.has(row.actorId))
      .map((row) => rowForDynamo('relays', row)))
  ]);

  for (const [tableName, rows, existing] of [
    [followerTable, source.followers, targetFollowers],
    [relayTable, source.relays, targetRelays]
  ]) {
    const maximumId = Math.max(0, ...rows.map((row) => row.id));
    const existingCounter = existing.find((row) => row.actorId === '__blog_counter__');
    const counterId = Math.max(maximumId, Number(existingCounter?.id ?? 0));
    if (counterId > 0 && Number(existingCounter?.id ?? 0) < counterId) {
      await dynamo.send(new PutCommand({
        TableName: tableName,
        Item: { actorId: '__blog_counter__', id: counterId }
      }));
    }
  }

  await Promise.all([
    verifyTable(dynamo, followerTable, source.followers, 'followers'),
    verifyTable(dynamo, relayTable, source.relays, 'relays'),
    waitForIndexCounts(dynamo, source)
  ]);
  console.log('DynamoDB item contents, statuses, dates, counts, and state indexes match the D1 backup.');
} else {
  console.log('No DynamoDB writes made. Re-run with --apply after the CDK tables exist to import and verify these rows.');
}
