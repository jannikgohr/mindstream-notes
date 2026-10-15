-- Incremental sync checks losses for one account after its last cursor.
-- The primary key starts with collection_id and cannot serve this lookup.
CREATE INDEX removed_members_account_changes ON removed_members (account_id, stoken);
