import type { Env, GigRecord } from '../types';

export async function listActiveGigs(env: Pick<Env, 'DB'>): Promise<GigRecord[]> {
  const result = await env.DB.prepare(
    `SELECT gig_id, buyer_pubkey, worker_pubkey, title, description, task_type, payload_json, bounty_sats, status, lifecycle_state, lifecycle_version, created_at, updated_at, expires_at
     FROM agent_gigs
     WHERE status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     ORDER BY expires_at DESC
     LIMIT 100`
  ).all<GigRecord>();
  return result.results;
}
