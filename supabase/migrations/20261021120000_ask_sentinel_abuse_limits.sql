-- Ask Sentinel abuse limits.
--
-- The per-user quota (3 a day) is keyed by whatever identity the request
-- carries. Until the dashboard loaded a real supabase-js release, every request
-- used a client-chosen visitor UUID, so a script could mint a new "user" per
-- question and spend the whole provider budget. These limits sit underneath the
-- per-user quota and do not depend on the identity at all:
--   * per network: attempts per day from one client IP (stored only as a keyed,
--     day-scoped hash, never the address itself), and
--   * per service: attempts per day in total, a hard ceiling on provider cost.
-- Attempts are counted when a provider call is about to be made and are never
-- refunded; the per-user quota is refunded when the failure was ours (provider
-- outage, or an answer rejected by citation validation).

create table if not exists public.ask_sentinel_ip_usage (
  ip_hash text not null,
  usage_date date not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  primary key (ip_hash, usage_date)
);
create index if not exists ask_sentinel_ip_usage_date_idx on public.ask_sentinel_ip_usage (usage_date);
alter table public.ask_sentinel_ip_usage enable row level security;
revoke all on public.ask_sentinel_ip_usage from anon, authenticated;
grant all on public.ask_sentinel_ip_usage to service_role;

create table if not exists public.ask_sentinel_daily_usage (
  usage_date date primary key,
  attempt_count integer not null default 0 check (attempt_count >= 0)
);
alter table public.ask_sentinel_daily_usage enable row level security;
revoke all on public.ask_sentinel_daily_usage from anon, authenticated;
grant all on public.ask_sentinel_daily_usage to service_role;

-- Locks are always taken in the same order (service day, network, user), so
-- concurrent requests serialise instead of deadlocking, and a request refused
-- by one limit never consumes the others.
create or replace function public.consume_ask_sentinel_request_v2(
  p_user_id uuid,
  p_ip_hash text,
  p_usage_date date,
  p_ip_limit integer default 12,
  p_global_limit integer default 300
)
returns table(allowed boolean, remaining integer, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip_hash text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_global integer;
  v_ip integer;
  v_user integer;
begin
  insert into public.ask_sentinel_daily_usage (usage_date) values (p_usage_date) on conflict do nothing;
  if found then
    -- First request of a new day: network hashes older than two weeks have no use.
    delete from public.ask_sentinel_ip_usage where usage_date < p_usage_date - 14;
  end if;
  select d.attempt_count into v_global from public.ask_sentinel_daily_usage d where d.usage_date = p_usage_date for update;
  if v_global >= greatest(p_global_limit, 0) then
    return query select false, 0, 'global_limit'::text;
    return;
  end if;

  insert into public.ask_sentinel_ip_usage (ip_hash, usage_date) values (v_ip_hash, p_usage_date) on conflict do nothing;
  select i.attempt_count into v_ip from public.ask_sentinel_ip_usage i
   where i.ip_hash = v_ip_hash and i.usage_date = p_usage_date for update;
  if v_ip >= greatest(p_ip_limit, 0) then
    return query select false, 0, 'ip_limit'::text;
    return;
  end if;

  insert into public.ask_sentinel_usage (user_id, usage_date, request_count) values (p_user_id, p_usage_date, 0) on conflict do nothing;
  select u.request_count into v_user from public.ask_sentinel_usage u
   where u.user_id = p_user_id and u.usage_date = p_usage_date for update;
  if v_user >= 3 then
    return query select false, 0, 'user_limit'::text;
    return;
  end if;

  update public.ask_sentinel_daily_usage set attempt_count = attempt_count + 1 where usage_date = p_usage_date;
  update public.ask_sentinel_ip_usage set attempt_count = attempt_count + 1 where ip_hash = v_ip_hash and usage_date = p_usage_date;
  update public.ask_sentinel_usage set request_count = request_count + 1 where user_id = p_user_id and usage_date = p_usage_date;
  return query select true, greatest(0, 3 - (v_user + 1)), 'ok'::text;
end;
$$;
revoke all on function public.consume_ask_sentinel_request_v2(uuid, text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ask_sentinel_request_v2(uuid, text, date, integer, integer) to service_role;

-- Gives one question back to the user when the failure was the service's, not
-- theirs. Network and service attempt counts are deliberately left as they are.
create or replace function public.refund_ask_sentinel_request(p_user_id uuid, p_usage_date date)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.ask_sentinel_usage
     set request_count = greatest(0, request_count - 1)
   where user_id = p_user_id and usage_date = p_usage_date
  returning greatest(0, 3 - request_count);
$$;
revoke all on function public.refund_ask_sentinel_request(uuid, date) from public, anon, authenticated;
grant execute on function public.refund_ask_sentinel_request(uuid, date) to service_role;
