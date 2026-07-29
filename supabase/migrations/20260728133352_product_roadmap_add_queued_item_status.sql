-- Adds the "ready to ship, waiting on a deploy" state to the roadmap item pipeline.
-- Placed before 'launched' so enum ordering still matches the board column order:
-- idea -> planned -> in_progress -> in_review -> queued -> launched -> declined.
-- NOTE: Postgres cannot drop an enum value, so this addition is one-way.
--
-- Must be its own migration: Postgres will not let a new enum value be USED in the
-- same transaction that adds it.
alter type product_roadmap_item_status add value if not exists 'queued' before 'launched';
