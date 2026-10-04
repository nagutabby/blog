import { createRequire } from 'node:module';

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient
} = requireFromWeb('@aws-sdk/client-secrets-manager');

const secretPairs = [
  [process.env.OLD_RUNTIME_SECRET ?? 'sveltekit-blog/runtime', process.env.RUNTIME_SECRET ?? 'blog/runtime'],
  [process.env.OLD_ORIGIN_HEADER_SECRET ?? 'sveltekit-blog/cloudfront-origin-header', process.env.ORIGIN_HEADER_SECRET ?? 'blog/cloudfront-origin-header']
];
const apply = process.argv.includes('--apply');
const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });

async function readSecret(secretId) {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (typeof response.SecretString !== 'string') {
    throw new Error(`${secretId} does not contain a text secret.`);
  }
  return response.SecretString;
}

for (const [sourceId, targetId] of secretPairs) {
  if (sourceId === targetId) throw new Error(`Source and target secret names must differ: ${sourceId}`);
  const sourceValue = await readSecret(sourceId);
  const targetValue = await readSecret(targetId);
  if (sourceValue === targetValue) {
    console.log(`${sourceId} -> ${targetId}: values match.`);
    continue;
  }
  if (!apply) {
    console.log(`${sourceId} -> ${targetId}: values differ; no value was printed.`);
    continue;
  }

  await client.send(new PutSecretValueCommand({ SecretId: targetId, SecretString: sourceValue }));
  const verifiedValue = await readSecret(targetId);
  if (verifiedValue !== sourceValue) throw new Error(`Post-copy verification failed for ${targetId}.`);
  console.log(`${sourceId} -> ${targetId}: copied and verified.`);
}

if (!apply) console.log('Read-only check complete. Add --apply to copy mismatched secret values.');
