-- ============================================================================
-- Launch notification pipeline
--
--   item hits 'queued'  ->  trigger enqueues a pending notification
--   deploy webhook fires ->  edge function claims the queue as one "batch",
--                            flips those items to 'launched', and sends a single
--                            digest email per recipient via Resend
--
-- Three tables, mirroring the existing email_campaigns / email_campaign_recipients
-- shape: the queue (per item), the run (per deploy), and delivery (per person).
-- ============================================================================

create type product_roadmap_launch_status as enum ('pending', 'sending', 'sent', 'failed', 'cancelled');

-- ---------------------------------------------------------------- the run ---
create table product_roadmap_launch_batches (
  id              uuid primary key default uuid_generate_v4(),
  status          product_roadmap_launch_status not null default 'pending',
  -- A dry run resolves items and recipients and renders the email, but neither
  -- flips any item to 'launched' nor sends anything.
  dry_run         boolean not null default true,
  triggered_by    text,
  subject         text,
  item_count      integer not null default 0,
  recipient_count integer not null default 0,
  sent_count      integer not null default 0,
  failed_count    integer not null default 0,
  error           text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- -------------------------------------------------------------- the queue ---
create table product_roadmap_launch_notifications (
  id          uuid primary key default uuid_generate_v4(),
  item_id     uuid not null references product_roadmap_items(id) on delete cascade,
  batch_id    uuid references product_roadmap_launch_batches(id) on delete set null,
  status      product_roadmap_launch_status not null default 'pending',
  queued_by   uuid,
  queued_at   timestamptz not null default now(),
  released_at timestamptz,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- An item can only sit in the queue once at a time; re-queuing after a send is
-- fine, which is why this is a partial index rather than a plain unique constraint.
create unique index product_roadmap_launch_notifications_open_item_idx
  on product_roadmap_launch_notifications (item_id)
  where status in ('pending', 'sending');

create index product_roadmap_launch_notifications_status_idx on product_roadmap_launch_notifications (status);
create index product_roadmap_launch_notifications_batch_idx  on product_roadmap_launch_notifications (batch_id);

create trigger trg_prm_launch_notifications_updated_at
  before update on product_roadmap_launch_notifications
  for each row execute function product_roadmap_set_updated_at();

-- ----------------------------------------------------------- the delivery ---
create table product_roadmap_launch_batch_recipients (
  id            uuid primary key default uuid_generate_v4(),
  batch_id      uuid not null references product_roadmap_launch_batches(id) on delete cascade,
  -- users.whalesync_postgres_id (the users PK) and users.user_auth_id, which is
  -- what every other product_roadmap uuid column actually points at.
  user_id       uuid,
  auth_user_id  uuid,
  email         text not null,
  status        text not null default 'pending',
  resend_id     text,
  error_message text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index product_roadmap_launch_batch_recipients_batch_idx on product_roadmap_launch_batch_recipients (batch_id);

-- ------------------------------------------------------------- the enqueue ---
create function product_roadmap_enqueue_launch_notification()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'queued' and old.status is distinct from new.status then
    insert into product_roadmap_launch_notifications (item_id, queued_by)
    values (new.id, auth.uid())
    on conflict do nothing;

  -- Backing an item out of 'queued' before the deploy withdraws it from the queue,
  -- so it can't ship a notification for something that got pulled.
  elsif old.status = 'queued' and new.status <> 'queued' and new.status <> 'launched' then
    update product_roadmap_launch_notifications
       set status = 'cancelled'
     where item_id = new.id
       and status = 'pending';
  end if;

  return new;
end;
$$;

create trigger trg_prm_enqueue_launch_notification
  after update of status on product_roadmap_items
  for each row execute function product_roadmap_enqueue_launch_notification();

-- ------------------------------------------------------------- recipients ---
-- The audience for a launch email, in one place so the edge function and any
-- future digest share a single definition.
create view product_roadmap_launch_recipients as
  select
    u.whalesync_postgres_id as user_id,
    u.user_auth_id          as auth_user_id,
    u.name,
    u.email
  from users u
  where u.status = 'Active'
    and u.email_notifications_enabled
    and u.email is not null
    and u.email <> '';

comment on view product_roadmap_launch_recipients is
  'Active users who accept email notifications - the audience for roadmap launch digests.';
