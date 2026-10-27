-- Ask Sentinel agent: fast search, 50 questions a day, and a provider budget.
--
-- 1. Search. search_ask_sentinel_chunks joined every word of the question with
--    OR and ranked every match with ts_rank_cd. Ordinary words ("changed",
--    "last", "days") match almost all 34k chunks, so a typical question ranked
--    the whole table: 15.4 s against the 8 s statement timeout, and every
--    question in the 24 h before this migration failed in the search phase
--    ("Ask Sentinel is temporarily unavailable"). 28k of those chunks are
--    extracted page snapshots that the function then discarded for anything
--    but implementation questions.
--    The search now takes chunks that contain every word first, fills up with
--    the most recently indexed any-word matches (capped), and ranks only that
--    small candidate set. Page snapshots are left out unless asked for.
--    The same question runs in ~10 ms warm and ~1.4 s cold.
--
-- 2. Quota. One question is one turn of the agent, however many tool steps it
--    takes. The per-user limit is a parameter (the Edge Function passes 50).
--
-- 3. Provider budget. openrouter/free allows 1,000 requests a day on this
--    account (20 a minute). An agent turn makes several model calls, so calls
--    are counted per day and refused once the cap the Edge Function passes is
--    reached, before OpenRouter starts refusing them.

-- Only non-snapshot chunks: this is what nearly every question searches.
create index if not exists ask_sentinel_chunks_search_records_idx
  on public.ask_sentinel_chunks using gin (search)
  where doc_type <> 'extracted page snapshot';

create or replace function public.search_ask_sentinel_chunks_v3(
  p_query text,
  p_limit integer default 45,
  p_include_snapshots boolean default false,
  p_include_core boolean default true
)
returns table(path text, doc_type text, content text, is_core boolean, score real)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select
      websearch_to_tsquery('english', left(coalesce(p_query, ''), 500)) as tsq_all,
      nullif(replace(websearch_to_tsquery('english', left(coalesce(p_query, ''), 500))::text, ' & ', ' | '), '')::tsquery as tsq_any
  ),
  every_word as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c, q
     where q.tsq_any is not null
       and not c.is_core
       and c.doc_type <> 'extracted page snapshot'
       and c.search @@ q.tsq_all
     limit 400
  ),
  every_word_snapshots as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c, q
     where p_include_snapshots
       and q.tsq_any is not null
       and c.doc_type = 'extracted page snapshot'
       and c.search @@ q.tsq_all
     limit 200
  ),
  any_word as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c, q
     where q.tsq_any is not null
       and not c.is_core
       and c.doc_type <> 'extracted page snapshot'
       and c.search @@ q.tsq_any
     order by c.updated_at desc
     limit 300
  ),
  candidates as (
    select * from every_word
    union select * from every_word_snapshots
    union select * from any_word
  ),
  ranked as (
    select c.path, c.doc_type, c.content, c.is_core,
           (ts_rank(c.search, q.tsq_any)
             + case when c.search @@ q.tsq_all then 2 else 0 end
             + case when c.path like '\_\_%' then 0.05 else 0 end)::real as score,
           c.updated_at
      from candidates k
      join public.ask_sentinel_chunks c using (path, chunk_index)
      cross join q
  ),
  core as (
    select c.path, c.doc_type, c.content, c.is_core, 1000::real as score, c.updated_at
      from public.ask_sentinel_chunks c
     where p_include_core and c.is_core
  )
  select r.path, r.doc_type, r.content, r.is_core, r.score
    from (select * from core union all select * from ranked) r
   order by r.is_core desc, r.score desc, r.updated_at desc
   limit least(greatest(coalesce(p_limit, 45), 1), 60);
$$;
revoke all on function public.search_ask_sentinel_chunks_v3(text, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.search_ask_sentinel_chunks_v3(text, integer, boolean, boolean) to service_role;

-- The deployed Edge Function still calls the two-argument search. Point it at
-- the fast path so questions stop timing out as soon as this migration runs,
-- before the function itself is redeployed.
create or replace function public.search_ask_sentinel_chunks(p_query text, p_limit integer default 45)
returns table(path text, doc_type text, content text, is_core boolean, score real)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.search_ask_sentinel_chunks_v3(p_query, p_limit, false, true);
$$;
revoke all on function public.search_ask_sentinel_chunks(text, integer) from public, anon, authenticated;
grant execute on function public.search_ask_sentinel_chunks(text, integer) to service_role;

-- Provider calls per day, next to the question count.
alter table public.ask_sentinel_daily_usage
  add column if not exists provider_calls integer not null default 0 check (provider_calls >= 0);

-- One agent turn (a question). Same lock order and limits as v2 (service day,
-- network, user), with the per-user limit passed in instead of fixed at 3.
create or replace function public.consume_ask_sentinel_turn(
  p_user_id uuid,
  p_ip_hash text,
  p_usage_date date,
  p_user_limit integer default 50,
  p_ip_limit integer default 60,
  p_global_limit integer default 200
)
returns table(allowed boolean, remaining integer, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ip_hash text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_limit integer := greatest(coalesce(p_user_limit, 50), 0);
  v_global integer;
  v_ip integer;
  v_user integer;
begin
  insert into public.ask_sentinel_daily_usage (usage_date) values (p_usage_date) on conflict do nothing;
  if found then
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
  if v_user >= v_limit then
    return query select false, 0, 'user_limit'::text;
    return;
  end if;

  update public.ask_sentinel_daily_usage set attempt_count = attempt_count + 1 where usage_date = p_usage_date;
  update public.ask_sentinel_ip_usage set attempt_count = attempt_count + 1 where ip_hash = v_ip_hash and usage_date = p_usage_date;
  update public.ask_sentinel_usage set request_count = request_count + 1 where user_id = p_user_id and usage_date = p_usage_date;
  return query select true, greatest(0, v_limit - (v_user + 1)), 'ok'::text;
end;
$$;
revoke all on function public.consume_ask_sentinel_turn(uuid, text, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_ask_sentinel_turn(uuid, text, date, integer, integer, integer) to service_role;

create or replace function public.refund_ask_sentinel_turn(
  p_user_id uuid,
  p_usage_date date,
  p_user_limit integer default 50
)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.ask_sentinel_usage
     set request_count = greatest(0, request_count - 1)
   where user_id = p_user_id and usage_date = p_usage_date
  returning greatest(0, greatest(coalesce(p_user_limit, 50), 0) - request_count);
$$;
revoke all on function public.refund_ask_sentinel_turn(uuid, date, integer) from public, anon, authenticated;
grant execute on function public.refund_ask_sentinel_turn(uuid, date, integer) to service_role;

-- One model call. Returns false once the day's cap is reached.
create or replace function public.consume_ask_sentinel_provider_call(
  p_usage_date date,
  p_cap integer default 950
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calls integer;
begin
  insert into public.ask_sentinel_daily_usage (usage_date) values (p_usage_date) on conflict do nothing;
  select d.provider_calls into v_calls from public.ask_sentinel_daily_usage d where d.usage_date = p_usage_date for update;
  if v_calls >= greatest(coalesce(p_cap, 950), 0) then
    return false;
  end if;
  update public.ask_sentinel_daily_usage set provider_calls = provider_calls + 1 where usage_date = p_usage_date;
  return true;
end;
$$;
revoke all on function public.consume_ask_sentinel_provider_call(date, integer) from public, anon, authenticated;
grant execute on function public.consume_ask_sentinel_provider_call(date, integer) to service_role;
