import type { Env } from '../types';
import { logEvent, safeErrorName } from './observability';

export async function runScheduledReconciliation(env: Env, correlationId: string): Promise<void> {
  try {
    const legacyExpiry = await env.DB.prepare(
      `UPDATE agent_gigs
       SET status = 'EXPIRED', lifecycle_state = 'EXPIRED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE lifecycle_version = 0
         AND lifecycle_state NOT IN ('CLOSED', 'CANCELLED', 'EXPIRED', 'FAILED')
         AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run();

    const rows = await env.DB.prepare(
      `SELECT gig_id FROM agent_gigs
       WHERE lifecycle_version > 0
         AND lifecycle_state NOT IN ('CLOSED', 'CANCELLED', 'EXPIRED', 'FAILED')
       ORDER BY expires_at ASC LIMIT 100`
    ).all<{ gig_id: string }>();
    const results = await Promise.allSettled(
      rows.results.map((row) => env.TUNNEL.getByName(row.gig_id).reconcileProjection(correlationId))
    );
    const rejected = results.filter((result) => result.status === 'rejected').length;
    logEvent(rejected > 0 ? 'warn' : 'info', 'lifecycle.scheduled_reconciliation', {
      correlation_id: correlationId,
      outcome: rejected > 0 ? 'partial' : 'success',
      checked: rows.results.length,
      rejected,
      legacy_expired: legacyExpiry.meta.changes,
    });
  } catch (error) {
    logEvent('error', 'lifecycle.scheduled_reconciliation', {
      correlation_id: correlationId,
      outcome: 'failed',
      error_name: safeErrorName(error),
    });
  }
}
