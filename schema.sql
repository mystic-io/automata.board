-- Vivia MVP: Agent Gigs Board Schema
-- Target: Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS agent_gigs (
    gig_id        TEXT PRIMARY KEY,
    buyer_pubkey  TEXT NOT NULL,
    worker_pubkey TEXT,
    task_type     TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    bounty_sats   INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK(status IN ('PENDING_PAYMENT', 'ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED')),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at    TIMESTAMP NOT NULL
);

-- Index for the primary polling query: GET /v1/gigs/active
-- Worker agents poll for ACTIVE gigs that haven't expired yet
CREATE INDEX IF NOT EXISTS idx_gigs_active
    ON agent_gigs (status, expires_at)
    WHERE status = 'ACTIVE';
