-- Withdraw rows an older build left behind.
--
-- An invitation is only a way in for someone outside, and a link carries
-- only the authority of an admin who still has it. Builds before these rules
-- were enforced could leave an invitation addressed to an existing member,
-- an invitation sent by a removed or demoted admin, or a link made by one.
-- The handlers now withdraw these when access changes; this clears the rows
-- that were already stored and gives back the bytes they counted for.

WITH stale_invitations AS (
    DELETE FROM invitations i
    WHERE EXISTS (
        SELECT 1 FROM members m
        WHERE m.collection_id = i.collection_id
          AND m.account_id = i.to_account_id
    )
    OR NOT EXISTS (
        SELECT 1 FROM members m
        WHERE m.collection_id = i.collection_id
          AND m.account_id = i.from_account_id
          AND m.access_level = 1
    )
    RETURNING i.collection_id,
              (octet_length(i.uid) + octet_length(i.signed_encryption_key))::bigint AS bytes
), stale_links AS (
    -- Access level 1 is admin; see collections::ACCESS_ADMIN.
    DELETE FROM invite_links l
    WHERE NOT EXISTS (
        SELECT 1 FROM members m
        WHERE m.collection_id = l.collection_id
          AND m.account_id = l.from_account_id
          AND m.access_level = 1
    )
    RETURNING l.collection_id,
              (octet_length(l.uid) + octet_length(l.signed_encryption_key)
               + octet_length(l.claim_pubkey))::bigint AS bytes
), freed AS (
    SELECT collection_id, sum(bytes)::bigint AS bytes
    FROM (
        SELECT collection_id, bytes FROM stale_invitations
        UNION ALL
        SELECT collection_id, bytes FROM stale_links
    ) gone
    GROUP BY collection_id
)
UPDATE collections c
SET bytes_used = GREATEST(c.bytes_used - freed.bytes, 0)
FROM freed
WHERE c.id = freed.collection_id;
