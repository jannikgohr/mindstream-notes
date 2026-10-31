-- Count the bytes of every stored field, not only content and metadata.
--
-- Keys, item and revision uids, chunk uids, invitation keys and link keys
-- are chosen by a client and stored by the server. A plan that counts only
-- content could be filled with rows whose content is empty, so existing
-- collections are counted again under the wider rule.
UPDATE collections c
SET bytes_used =
    (SELECT COALESCE(sum(octet_length(i.uid)
         + COALESCE(octet_length(i.encryption_key), 0)
         + octet_length(i.revision_uid)), 0)
     FROM items i WHERE i.collection_id = c.id)
    + (SELECT COALESCE(sum(octet_length(r.uid) + octet_length(r.meta)), 0)
       FROM revisions r JOIN items i ON i.id = r.item_id
       WHERE i.collection_id = c.id)
    + (SELECT COALESCE(sum(octet_length(k.uid) + k.size), 0)
       FROM chunks k WHERE k.collection_id = c.id)
    + (SELECT COALESCE(sum(octet_length(m.encryption_key)
         + octet_length(m.collection_type)), 0)
       FROM members m WHERE m.collection_id = c.id)
    + (SELECT COALESCE(sum(octet_length(v.uid)
         + octet_length(v.signed_encryption_key)), 0)
       FROM invitations v WHERE v.collection_id = c.id)
    + (SELECT COALESCE(sum(octet_length(l.uid)
         + octet_length(l.signed_encryption_key)
         + octet_length(l.claim_pubkey)), 0)
       FROM invite_links l WHERE l.collection_id = c.id);
