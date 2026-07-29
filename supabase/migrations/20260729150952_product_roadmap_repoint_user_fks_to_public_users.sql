-- Repoint every product_roadmap user column from auth.users(id) to
-- public.users(user_auth_id), matching what was done by hand on
-- product_roadmap_projects.owner_id.
--
-- Why: PostgREST cannot traverse into the auth schema, so an FK to auth.users
-- gives WeWeb nothing to embed. Pointing at public.users lets a collection select
-- created_by(id,name,user_auth_id) and carry the name inline, instead of pulling
-- the whole users table into the browser.
--
-- The uuid values are identical either way (users.user_auth_id IS the auth id), so
-- no data changes -- only the constraint target. Existing delete rules are kept.
--
-- Depends on 20260729150844_product_roadmap_harden_actor_triggers.sql: the actor
-- triggers must resolve auth.uid() through users BEFORE these FKs exist, or a
-- status change by an auth user with no public.users row will fail outright.

-- ---- items ----------------------------------------------------------------
alter table product_roadmap_items drop constraint product_roadmap_items_created_by_fkey;
alter table product_roadmap_items
  add constraint product_roadmap_items_created_by_fkey
  foreign key (created_by) references users(user_auth_id) on delete set null;

alter table product_roadmap_items drop constraint product_roadmap_items_assigned_to_fkey;
alter table product_roadmap_items
  add constraint product_roadmap_items_assigned_to_fkey
  foreign key (assigned_to) references users(user_auth_id) on delete set null;

-- ---- comments -------------------------------------------------------------
alter table product_roadmap_comments drop constraint product_roadmap_comments_user_id_fkey;
alter table product_roadmap_comments
  add constraint product_roadmap_comments_user_id_fkey
  foreign key (user_id) references users(user_auth_id) on delete cascade;

-- ---- reactions ------------------------------------------------------------
alter table product_roadmap_reactions drop constraint product_roadmap_reactions_user_id_fkey;
alter table product_roadmap_reactions
  add constraint product_roadmap_reactions_user_id_fkey
  foreign key (user_id) references users(user_auth_id) on delete cascade;

-- ---- upvotes --------------------------------------------------------------
alter table product_roadmap_upvotes drop constraint product_roadmap_upvotes_user_id_fkey;
alter table product_roadmap_upvotes
  add constraint product_roadmap_upvotes_user_id_fkey
  foreign key (user_id) references users(user_auth_id) on delete cascade;

-- ---- watchers -------------------------------------------------------------
alter table product_roadmap_watchers drop constraint product_roadmap_watchers_user_id_fkey;
alter table product_roadmap_watchers
  add constraint product_roadmap_watchers_user_id_fkey
  foreign key (user_id) references users(user_auth_id) on delete cascade;

-- ---- status history -------------------------------------------------------
alter table product_roadmap_status_history drop constraint product_roadmap_status_history_changed_by_fkey;
alter table product_roadmap_status_history
  add constraint product_roadmap_status_history_changed_by_fkey
  foreign key (changed_by) references users(user_auth_id) on delete set null;

-- ---- attachments ----------------------------------------------------------
alter table product_roadmap_attachments drop constraint product_roadmap_attachments_uploaded_by_fkey;
alter table product_roadmap_attachments
  add constraint product_roadmap_attachments_uploaded_by_fkey
  foreign key (uploaded_by) references users(user_auth_id) on delete set null;

-- ---- launch queue (these never had a user FK) -----------------------------
alter table product_roadmap_launch_notifications
  add constraint product_roadmap_launch_notifications_queued_by_fkey
  foreign key (queued_by) references users(user_auth_id) on delete set null;

-- The delivery log keeps its rows when a user goes away. Note user_id here points
-- at the users primary key, not the auth id.
alter table product_roadmap_launch_batch_recipients
  add constraint product_roadmap_launch_batch_recipients_auth_user_id_fkey
  foreign key (auth_user_id) references users(user_auth_id) on delete set null;

alter table product_roadmap_launch_batch_recipients
  add constraint product_roadmap_launch_batch_recipients_user_id_fkey
  foreign key (user_id) references users(whalesync_postgres_id) on delete set null;

-- FK columns are not indexed automatically; without these, deleting a user forces
-- a sequential scan of every roadmap table to enforce the rule.
create index if not exists product_roadmap_items_created_by_idx          on product_roadmap_items (created_by);
create index if not exists product_roadmap_items_assigned_to_idx         on product_roadmap_items (assigned_to);
create index if not exists product_roadmap_comments_user_id_idx          on product_roadmap_comments (user_id);
create index if not exists product_roadmap_reactions_user_id_idx         on product_roadmap_reactions (user_id);
create index if not exists product_roadmap_upvotes_user_id_idx           on product_roadmap_upvotes (user_id);
create index if not exists product_roadmap_watchers_user_id_idx          on product_roadmap_watchers (user_id);
create index if not exists product_roadmap_status_history_changed_by_idx on product_roadmap_status_history (changed_by);
create index if not exists product_roadmap_attachments_uploaded_by_idx   on product_roadmap_attachments (uploaded_by);
