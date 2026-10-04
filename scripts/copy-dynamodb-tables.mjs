import { createRequire } from 'node:module';

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { DynamoDBClient } = requireFromWeb('@aws-sdk/client-dynamodb');
const {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand
} = requireFromWeb('@aws-sdk/lib-dynamodb');

const tablePairs = [
  [process.env.OLD_FOLLOWER_TABLE ?? 'sveltekit-blog-followers', process.env.FOLLOWER_TABLE ?? 'blog-followers'],
  [process.env.OLD_RELAY_TABLE ?? 'sveltekit-blog-relay-connections', process.env.RELAY_TABLE ?? 'blog-relay-connections']
];
const apply = process.argv.includes('--apply');
const region = process.env.AWS_REGION ?? 'ap-northeast-1';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

function stable(value) {
  if (value instanceof Uint8Array) return { binary: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function scanAll(tableName) {
  const items = [];
  let lastKey;
  do {
    const response = await client.send(new ScanCommand({
      TableName: tableName,
      ConsistentRead: true,
      ExclusiveStartKey: lastKey
    }));
    items.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function compare(source, target) {
  for (const item of [...source, ...target]) {
    if (typeof item.actorId !== 'string' || item.actorId.length === 0) {
      throw new Error('A scanned item has no actorId partition key.');
    }
  }
  const sourceByKey = new Map(source.map((item) => [item.actorId, item]));
  const targetByKey = new Map(target.map((item) => [item.actorId, item]));
  let missing = 0;
  let different = 0;
  let extra = 0;
  for (const [key, sourceItem] of sourceByKey) {
    const targetItem = targetByKey.get(key);
    if (!targetItem) missing += 1;
    else if (!same(sourceItem, targetItem)) different += 1;
  }
  for (const key of targetByKey.keys()) if (!sourceByKey.has(key)) extra += 1;
  return { missing, different, extra, equal: missing === 0 && different === 0 && extra === 0 };
}

async function writeAll(tableName, items) {
  for (let offset = 0; offset < items.length; offset += 25) {
    let requestItems = { [tableName]: items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } })) };
    let attempt = 0;
    while (Object.keys(requestItems).length > 0 && requestItems[tableName]?.length) {
      const response = await client.send(new BatchWriteCommand({ RequestItems: requestItems }));
      requestItems = response.UnprocessedItems ?? {};
      if (requestItems[tableName]?.length) {
        attempt += 1;
        if (attempt > 8) throw new Error(`DynamoDB kept returning unprocessed items for ${tableName}.`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10000)));
      }
    }
  }
}

for (const [sourceName, targetName] of tablePairs) {
  if (sourceName === targetName) throw new Error(`Source and target table names must differ: ${sourceName}`);
  const sourceBefore = await scanAll(sourceName);
  const targetBefore = await scanAll(targetName);
  const before = compare(sourceBefore, targetBefore);
  console.log(`${sourceName} -> ${targetName}: source=${sourceBefore.length}, target=${targetBefore.length}, missing=${before.missing}, different=${before.different}, extra=${before.extra}`);

  if (before.extra) throw new Error(`Target table ${targetName} has items absent from the source; refusing to delete or overwrite them.`);
  if (apply && !before.equal) await writeAll(targetName, sourceBefore);

  const sourceAfter = apply ? await scanAll(sourceName) : sourceBefore;
  const targetAfter = apply ? await scanAll(targetName) : targetBefore;
  if (apply && !compare(sourceBefore, sourceAfter).equal) {
    throw new Error(`Source table ${sourceName} changed during the copy. Keep writes paused and rerun verification.`);
  }
  const after = compare(sourceAfter, targetAfter);
  console.log(`${targetName}: verified=${after.equal}, missing=${after.missing}, different=${after.different}, extra=${after.extra}`);
  if (apply && !after.equal) throw new Error(`Post-copy verification failed for ${targetName}.`);
}

if (!apply) console.log('Read-only check complete. Add --apply after confirming source writes are paused and targets are prepared.');
