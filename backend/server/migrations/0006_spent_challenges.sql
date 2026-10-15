-- Login challenges a signed request has answered.
--
-- A challenge is authenticated, so the server need not remember handing it
-- out, and it is good for five minutes. Without this a request that was
-- captured on its way could be sent again within those five minutes and
-- open a session of its own. A challenge is noted here by its nonce in the
-- transaction of the request that answers it, so it is spent only when that
-- request succeeds. A row is of no use once its challenge has expired.
CREATE TABLE spent_challenges (
    nonce      BYTEA PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX spent_challenges_expiry ON spent_challenges (expires_at);
