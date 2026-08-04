-- Announcement copy for the launch email, kept separate from `description`.
-- `description` is the internal "what are we building and why"; launch_notes is
-- what the whole company reads when the item ships. The digest falls back to
-- description when this is empty, so an item is never announced blank.
alter table product_roadmap_items add column if not exists launch_notes text;

comment on column product_roadmap_items.launch_notes is
  'Customer-facing announcement copy used by the launch digest email; falls back to description when null.';
