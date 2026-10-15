-- Sizes, offsets and limits come back from these columns signed. The code
-- only ever writes values that satisfy these, so they pin a corrupt or
-- planted row to a clean error instead of a wrapped range or a nonsense
-- plan. A negative entitlement refuses everything without saying anything
-- useful; since validation rejects negatives where they are set, none can
-- already be stored.
ALTER TABLE chunks ADD CONSTRAINT chunks_size_nonnegative CHECK (size >= 0);
ALTER TABLE chunks
    ADD CONSTRAINT chunks_blob_offset_nonnegative CHECK (blob_offset IS NULL OR blob_offset >= 0);
ALTER TABLE collections
    ADD CONSTRAINT collections_bytes_used_nonnegative CHECK (bytes_used >= 0);
ALTER TABLE entitlements
    ADD CONSTRAINT entitlements_storage_limit_nonnegative
        CHECK (storage_limit_bytes IS NULL OR storage_limit_bytes >= 0),
    ADD CONSTRAINT entitlements_max_spaces_nonnegative
        CHECK (max_spaces IS NULL OR max_spaces >= 0),
    ADD CONSTRAINT entitlements_max_members_nonnegative
        CHECK (max_members_per_space IS NULL OR max_members_per_space >= 0),
    ADD CONSTRAINT entitlements_max_item_nonnegative
        CHECK (max_item_bytes IS NULL OR max_item_bytes >= 0);
ALTER TABLE invite_links ADD CONSTRAINT invite_links_max_uses_positive CHECK (max_uses >= 1);
