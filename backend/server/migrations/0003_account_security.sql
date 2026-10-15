-- Second factors, backup codes and the recovery key.

-- When this session proved a second factor, if it did. A device signed in
-- that way may enrol a new authenticator with the password alone.
ALTER TABLE sessions ADD COLUMN second_factor_at TIMESTAMPTZ;

-- One row per factor. Only time-based one-time passwords exist so far; the
-- kind column is there for passkeys.
CREATE TABLE second_factors (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    -- Encrypted under a key kept outside the database. The server has to be
    -- able to read it to check a code, so it cannot be a hash.
    secret       BYTEA NOT NULL,
    -- NULL until a first code has shown the authenticator has the secret.
    confirmed_at TIMESTAMPTZ,
    -- The time step of the last code accepted. An older or equal one is a
    -- replay.
    last_step    BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one factor in use and one being set up, per kind.
CREATE UNIQUE INDEX second_factors_confirmed ON second_factors (account_id, kind)
    WHERE confirmed_at IS NOT NULL;
CREATE UNIQUE INDEX second_factors_pending ON second_factors (account_id, kind)
    WHERE confirmed_at IS NULL;

-- Single-use stand-ins for a code, for when the authenticator is lost.
CREATE TABLE backup_codes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    code_hash  BYTEA NOT NULL,
    used_at    TIMESTAMPTZ
);
CREATE INDEX backup_codes_account ON backup_codes (account_id);

-- A second copy of the account's keys, wrapped under a random secret only
-- the user holds, and the public key that proves they hold it.
ALTER TABLE accounts ADD COLUMN recovery_pubkey BYTEA;
ALTER TABLE accounts ADD COLUMN recovery_encrypted_content BYTEA;
