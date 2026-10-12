-- Limits are checked against everything an account owns, so that has to be
-- quick to add up.
CREATE INDEX collections_owner ON collections (owner_id);

-- It limits the content of one item, an attachment for instance, however
-- that content ends up stored.
ALTER TABLE entitlements RENAME COLUMN max_blob_bytes TO max_item_bytes;
