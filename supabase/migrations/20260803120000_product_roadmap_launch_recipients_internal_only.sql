-- Narrow the launch audience to internal staff only: an active @superior-maintenance.com
-- account that has not opted out of email. Previously this was every active user,
-- which included ~270 vendor/contractor gmail and yahoo addresses.
--
-- Matching is done on lower(btrim(email)) rather than the raw column: six rows in
-- `users` already carry trailing whitespace, and a future @Superior-Maintenance.com
-- would otherwise be silently excluded. The email is also trimmed on the way out so
-- Resend never receives an address with a stray space.
create or replace view product_roadmap_launch_recipients as
  select
    u.whalesync_postgres_id as user_id,
    u.user_auth_id          as auth_user_id,
    u.name,
    btrim(u.email)          as email
  from users u
  where u.status = 'Active'
    and u.email_notifications_enabled
    and u.email is not null
    and lower(btrim(u.email)) like '%@superior-maintenance.com';

comment on view product_roadmap_launch_recipients is
  'Internal staff who accept email notifications - the audience for roadmap launch digests. Active @superior-maintenance.com addresses only.';

-- create or replace does not necessarily carry these across, so restate them.
alter view product_roadmap_launch_recipients set (security_invoker = on);
revoke all on product_roadmap_launch_recipients from anon;
