-- Invite links and signup codes.

-- An invitation addressed to whoever holds a secret, not to an account. The
-- secret never reaches the server. The client derives two keys from it: one
-- the collection key is encrypted to, and one that signs for the link.
CREATE TABLE invite_links (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid                   TEXT NOT NULL UNIQUE,
    version               SMALLINT NOT NULL,
    collection_id         BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    from_account_id       BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    access_level          SMALLINT NOT NULL,
    -- The collection key, encrypted to the link's key and authenticated by
    -- the sender, as in an invitation.
    signed_encryption_key BYTEA NOT NULL,
    -- Verifies the signatures that show a caller holds the secret.
    claim_pubkey          BYTEA NOT NULL,
    max_uses              INTEGER NOT NULL,
    uses                  INTEGER NOT NULL DEFAULT 0,
    -- Whether the link also lets its holder create an account on a server
    -- that does not take signups from just anyone, and how many it has let.
    allows_signup         BOOLEAN NOT NULL DEFAULT FALSE,
    signups               INTEGER NOT NULL DEFAULT 0,
    expires_at            TIMESTAMPTZ NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invite_links_collection ON invite_links (collection_id, id);

-- Lets one person sign up where signup is not open. Made by an
-- administrator, and kept as a hash like a session token.
CREATE TABLE signup_codes (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_hash  BYTEA NOT NULL UNIQUE,
    -- Who it is for, in the administrator's words.
    note       TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL,
    used_by    BIGINT REFERENCES accounts (id) ON DELETE SET NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
