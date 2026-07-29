-- Match the RLS posture of the existing product_roadmap_* tables: RLS on, one
-- blanket policy for authenticated. The edge function uses the service role,
-- which bypasses RLS, so the sender is unaffected either way.
alter table product_roadmap_launch_batches            enable row level security;
alter table product_roadmap_launch_notifications      enable row level security;
alter table product_roadmap_launch_batch_recipients   enable row level security;

create policy "prm_launch_batches: authenticated all"
  on product_roadmap_launch_batches for all to authenticated using (true) with check (true);

create policy "prm_launch_notifications: authenticated all"
  on product_roadmap_launch_notifications for all to authenticated using (true) with check (true);

create policy "prm_launch_batch_recipients: authenticated all"
  on product_roadmap_launch_batch_recipients for all to authenticated using (true) with check (true);

-- The recipients view reads the users table, so make it honour the caller's own
-- permissions rather than the definer's - otherwise it would be a way to read
-- every user's email regardless of the policies on `users`.
alter view product_roadmap_launch_recipients set (security_invoker = on);
revoke all on product_roadmap_launch_recipients from anon;
