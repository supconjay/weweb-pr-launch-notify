-- Both of these triggers write auth.uid() into a column that is about to gain a
-- foreign key to users(user_auth_id). 17 auth.users currently have no public.users
-- row, so an unguarded auth.uid() would violate that FK and abort the whole status
-- update. Resolve the actor through users first, leaving NULL when there is no row.

create or replace function public.product_roadmap_record_status_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor uuid;
begin
  if old.status is distinct from new.status then
    select u.user_auth_id into actor from users u where u.user_auth_id = auth.uid();

    insert into product_roadmap_status_history(item_id, changed_by, old_status, new_status)
    values (new.id, actor, old.status, new.status);
  end if;
  return new;
end;
$$;

create or replace function public.product_roadmap_enqueue_launch_notification()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor uuid;
begin
  if new.status = 'queued' and old.status is distinct from new.status then
    select u.user_auth_id into actor from users u where u.user_auth_id = auth.uid();

    insert into product_roadmap_launch_notifications (item_id, queued_by)
    values (new.id, actor)
    on conflict do nothing;

  elsif old.status = 'queued' and new.status <> 'queued' and new.status <> 'launched' then
    update product_roadmap_launch_notifications
       set status = 'cancelled'
     where item_id = new.id
       and status = 'pending';
  end if;

  return new;
end;
$$;
