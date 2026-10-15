-- Mindstream server schema.
--
-- Everything a client uploads is ciphertext. The server stores it, orders it
-- and decides who may read or write it; it never interprets it.

CREATE TABLE server_meta (
    key   TEXT PRIMARY KEY,
    value BYTEA NOT NULL
);

-- One counter orders every change on the server. A writer takes the row lock
-- as its last step before committing, so numbers are handed out in commit
-- order. That is what lets a client keep one cursor across all its
-- collections: with per-collection counters, a transaction that commits late
-- could land behind a cursor that has already moved past it and never be
-- seen.
CREATE TABLE change_counter (
    id    BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    value BIGINT NOT NULL
);
INSERT INTO change_counter (value) VALUES (0);

CREATE TABLE accounts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username          TEXT NOT NULL,
    -- Lowercased, so usernames are unique without regard to case.
    username_key      TEXT NOT NULL UNIQUE,
    email             TEXT NOT NULL,
    version           SMALLINT NOT NULL,
    salt              BYTEA NOT NULL,
    -- Verifies the signature on a login. Derived by the client from the
    -- password; the server never sees the password or the key behind it.
    login_pubkey      BYTEA NOT NULL,
    -- Identity key other users encrypt invitations to.
    pubkey            BYTEA NOT NULL,
    -- The account's keys, encrypted under a key derived from the password.
    encrypted_content BYTEA NOT NULL,
    disabled          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plan and limits. A missing row, or a NULL limit, means unlimited, which is
-- what a self-hosted server gives everyone.
CREATE TABLE entitlements (
    account_id            BIGINT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    plan                  TEXT NOT NULL DEFAULT 'default',
    storage_limit_bytes   BIGINT,
    max_spaces            INTEGER,
    max_members_per_space INTEGER,
    max_blob_bytes        BIGINT,
    -- A lapsed subscription: pulls and deletes keep working, pushes do not.
    read_only             BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per signed-in device. Only a hash of the token is kept.
CREATE TABLE sessions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE,
    device_name  TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account ON sessions (account_id);

CREATE TABLE collections (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid        TEXT NOT NULL UNIQUE,
    -- Pays for the collection's storage.
    owner_id   BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- Number of the latest change to an item or a membership in here.
    stoken     BIGINT NOT NULL,
    -- Ciphertext bytes stored, counted in the transaction that writes them.
    bytes_used BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id  BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    uid            TEXT NOT NULL,
    version        SMALLINT NOT NULL,
    encryption_key BYTEA,
    -- A collection is itself an item, the one carrying its name and content.
    is_main        BOOLEAN NOT NULL DEFAULT FALSE,
    -- The current revision, also the item's etag.
    revision_uid   TEXT NOT NULL,
    stoken         BIGINT NOT NULL,
    UNIQUE (collection_id, uid)
);
CREATE INDEX items_changes ON items (collection_id, stoken);
-- Exactly one main item per collection, and a direct way to reach it.
CREATE UNIQUE INDEX items_main ON items (collection_id) WHERE is_main;

CREATE TABLE revisions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id    BIGINT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    uid        TEXT NOT NULL,
    meta       BYTEA NOT NULL,
    deleted    BOOLEAN NOT NULL,
    chunk_ids  BIGINT[] NOT NULL,
    stoken     BIGINT NOT NULL,
    -- Who pushed it, taken from the session and not from anything the client
    -- claims. Items are encrypted, so this is the only authorship on record.
    author_id  BIGINT REFERENCES accounts (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, uid)
);
CREATE INDEX revisions_history ON revisions (item_id, id DESC);

-- Content is split into chunks by the client and addressed by a keyed hash,
-- so identical chunks within a collection are stored once.
CREATE TABLE chunks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    collection_id BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    uid           TEXT NOT NULL,
    size          INTEGER NOT NULL,
    -- A small chunk lives here.
    data          BYTEA,
    -- A large one lives in the blob store. One upload writes its large chunks
    -- into a single blob, so a chunk is `size` bytes of it from blob_offset.
    blob_key      TEXT,
    blob_offset   BIGINT,
    UNIQUE (collection_id, uid),
    CHECK ((data IS NULL) <> (blob_key IS NULL)),
    CHECK ((blob_key IS NULL) = (blob_offset IS NULL))
);

CREATE TABLE members (
    collection_id   BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    account_id      BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    access_level    SMALLINT NOT NULL,
    -- The collection key, encrypted for this member.
    encryption_key  BYTEA NOT NULL,
    -- The collection's type, encrypted deterministically under this member's
    -- account key, so they can list by type without the server learning it.
    collection_type BYTEA NOT NULL,
    stoken          BIGINT NOT NULL,
    PRIMARY KEY (collection_id, account_id)
);
CREATE INDEX members_account ON members (account_id);

-- Lets a client that still holds a cursor learn it lost access.
CREATE TABLE removed_members (
    collection_id BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    account_id    BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    stoken        BIGINT NOT NULL,
    PRIMARY KEY (collection_id, account_id)
);

CREATE TABLE invitations (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uid                   TEXT NOT NULL UNIQUE,
    version               SMALLINT NOT NULL,
    collection_id         BIGINT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    from_account_id       BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    to_account_id         BIGINT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    access_level          SMALLINT NOT NULL,
    -- The collection key, encrypted to the recipient and authenticated by the
    -- sender.
    signed_encryption_key BYTEA NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (collection_id, to_account_id)
);
CREATE INDEX invitations_to ON invitations (to_account_id, id);
CREATE INDEX invitations_from ON invitations (from_account_id, id);
