import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  const schema = env.RUNTIME_TEST_SCHEMA.replace(/^\s*--.*$/gm, '').trim();
  const statements = schema
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  await env.DB.prepare('DELETE FROM agent_gigs').run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS runtime_payment_nonces (nonce TEXT PRIMARY KEY)'
  ).run();
  await env.DB.prepare('DELETE FROM runtime_payment_nonces').run();
});
