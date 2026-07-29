-- Pin the search_path so the trigger can't be redirected by a caller-set path.
-- (The pre-existing product_roadmap_* functions carry the same advisory; this
-- only hardens the one added for the launch queue.)
alter function public.product_roadmap_enqueue_launch_notification() set search_path = public, pg_temp;
