-- Finding what a dropped revision leaves unused.
--
-- When a revision is deleted, each chunk it referred to is free unless
-- another revision still refers to it. That question is asked per chunk, and
-- without an index on the arrays it would read every revision there is.
--
-- The index is updated with each insert. By default Postgres collects new
-- entries in a list first and merges the list into the index when it fills,
-- inside whichever insert happens to fill it. Measured on 200,000 revisions,
-- inserts of 100 took 0.4 ms until the one that filled the list took 184 ms.
-- Without the list each took 0.5 ms, against 0.4 ms with no index at all.
-- Counting the commit, the index adds 0.2 ms to an insert that takes 2.8 ms.
CREATE INDEX revisions_chunks ON revisions USING gin (chunk_ids) WITH (fastupdate = off);

-- A blob goes when the last chunk stored in it has.
CREATE INDEX chunks_blob ON chunks (blob_key) WHERE blob_key IS NOT NULL;
