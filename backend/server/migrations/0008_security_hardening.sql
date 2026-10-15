-- Backup codes are hashed with Argon2id, so a database read hands out
-- nothing that opens an account. The old unsalted hashes cannot be
-- converted, so every code issued so far stops working; their owners make
-- new ones the next time they sign in with a device that is still signed
-- in. There are no other users yet, so nothing else is owed a migration.
DELETE FROM backup_codes;
ALTER TABLE backup_codes DROP COLUMN code_hash;
ALTER TABLE backup_codes ADD COLUMN code_hash TEXT NOT NULL;
