-- Ask Sentinel search: plan-safe tsquery and an index for the always-included chunks.
--
-- 31 Oct 2026: search_ask_sentinel_chunks_v3 took 15.7 s for "What changed in the latest
-- scan and which monitors failed?" (statement timeout 8 s, Postgres 57014), although the
-- same body with literal values ran in 59 ms. Two causes, both from the index growing to
-- 54k chunks (40k of them page snapshots):
--   1. Under the function's generic plan the q CTE was inlined, so websearch_to_tsquery()
--      was evaluated again for each of the ~9k rows a broad query matches.
--   2. The core chunks (is_core, 87 rows) were found by a sequential scan over every row.
-- With q MATERIALIZED and a partial index on is_core the generic plan runs in milliseconds.

create index if not exists ask_sentinel_chunks_core_idx
  on public.ask_sentinel_chunks (path, chunk_index)
  where is_core;

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
  -- MATERIALIZED: computed once. Inlined into a generic plan (SQL functions are planned
  -- with their parameters unknown), the tsquery was rebuilt for every row the GIN index
  -- returned; a broad question took 15.7 s against the 8 s statement timeout.
  with q as materialized (
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
