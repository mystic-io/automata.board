-- Additive local/test simulator replay protection. The production remote
-- facilitator does not use this table.
CREATE TABLE IF NOT EXISTS facilitator_simulator_nonces (
    nonce TEXT PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
