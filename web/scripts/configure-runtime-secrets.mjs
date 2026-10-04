import { generateKeyPairSync } from 'node:crypto';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secretId = process.argv[2] ?? 'blog/runtime';
const rotateActorKey = process.argv.includes('--rotate-actor-key');
const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });

/** @param {string} label */
function readHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so secret values are not echoed.');
  }
  process.stdout.write(`${label} (blank keeps the stored value): `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  /** @type {Promise<string>} */
  return new Promise((resolve, reject) => {
    let value = '';
    /** @param {Error} [error] */
    const finish = (error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function generateActorKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

const currentResponse = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
if (!currentResponse.SecretString) throw new Error('The runtime secret has no SecretString.');
const current = JSON.parse(currentResponse.SecretString);

const emailApiToken = await readHidden('Mailtrap API token');
const fromAddress = await readHidden('Sender email address');
const bccAddress = await readHidden('BCC email address');

const updated = {
  ...current,
  EMAIL_API_TOKEN: emailApiToken || current.EMAIL_API_TOKEN,
  FROM_ADDRESS: fromAddress || current.FROM_ADDRESS,
  BCC_ADDRESS: bccAddress || current.BCC_ADDRESS
};

for (const name of ['EMAIL_API_TOKEN', 'FROM_ADDRESS', 'BCC_ADDRESS', 'FEDERATION_ADMIN_TOKEN']) {
  if (typeof updated[name] !== 'string' || !updated[name]) throw new Error(`A value for ${name} is required.`);
}

if (rotateActorKey || !updated.ACTOR_PRIVATE_KEY_PEM || !updated.ACTOR_PUBLIC_KEY_PEM) {
  const keys = generateActorKeyPair();
  updated.ACTOR_PRIVATE_KEY_PEM = keys.privateKey;
  updated.ACTOR_PUBLIC_KEY_PEM = keys.publicKey;
}

await client.send(new PutSecretValueCommand({
  SecretId: secretId,
  SecretString: JSON.stringify(updated)
}));

console.log(`Updated ${secretId}; actor public key fingerprint: ${await publicKeyFingerprint(updated.ACTOR_PUBLIC_KEY_PEM)}`);

/** @param {string} publicKeyPEM */
async function publicKeyFingerprint(publicKeyPEM) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(publicKeyPEM).digest('hex').slice(0, 16);
}
