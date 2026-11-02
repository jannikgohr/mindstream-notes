-- Tell a member an admin took out from one who left.
--
-- Someone who left may come back by any link that still stands. Someone an
-- admin took out may not: the link they joined by may still have uses left,
-- and it would undo the removal. An invitation made afterwards is the admin
-- changing their mind, and clears this along with the rest of the row.
ALTER TABLE removed_members ADD COLUMN by_admin BOOLEAN NOT NULL DEFAULT FALSE;
