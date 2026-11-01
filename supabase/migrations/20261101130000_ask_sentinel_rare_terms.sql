-- Ask Sentinel search: match on the question's distinctive words, not on every word.
--
-- 1 Nov 2026: the live health check got HTTP 503 internal_search for three long questions
-- (e.g. "From the committed ChangeSentinel records, summarize exact monitoring run ...").
-- search_ask_sentinel_chunks_v3 took 9.4 s against the 8 s statement timeout:
--   1. any_word ORed every word of the question. Words such as "change", "source", "run" and
--      "error" are in ~85% of the 14k record chunks, so the OR matched almost all of them
--      and Postgres chose a sequential scan.
--   2. websearch_to_tsquery() turns "source_changed" and "fetch_error" into phrase operators
--      (sourc <-> chang). Replacing only " & " with " | " kept them, and a phrase forces a
--      recheck that reads (detoasts) the text of every matching row.
--   3. A SQL function runs on a generic plan, which cannot use the partial GIN index on
--      record chunks (ask_sentinel_chunks_search_records_idx).
-- Measured on the live index: 9.4 s before; 0.45 s for the same question with the body below.
--
-- The fix:
--   * ask_sentinel_common_lexemes holds the words found in at least 8% of record chunks,
--     from a 10% block sample (about 2.3 s; fits the 8 s API timeout, so the indexer can
--     refresh it after each upload).
--   * any_word ORs only the question's words that are not common. If every word is common,
--     it ORs all of them without phrase operators (about 1.4 s in the worst case measured).
--   * every_word still requires every word (phrases included); ranking still uses all words.
--   * plpgsql with plan_cache_mode = force_custom_plan, so each call is planned with its
--     own query and the partial index is used.

create table if not exists public.ask_sentinel_common_lexemes (
  word text primary key,
  ndoc integer not null,
  refreshed_at timestamptz not null default now()
);
alter table public.ask_sentinel_common_lexemes enable row level security;
revoke all on table public.ask_sentinel_common_lexemes from public, anon, authenticated;
grant select, insert, update, delete on table public.ask_sentinel_common_lexemes to service_role;

create or replace function public.refresh_ask_sentinel_common_lexemes(p_min_share real default 0.08)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_seed integer := floor(random() * 1000000)::integer;
  v_total integer;
  v_count integer;
begin
  -- The same sample (same seed) for the total and for the word counts.
  select count(*) into v_total
    from public.ask_sentinel_chunks tablesample system (10) repeatable (v_seed)
   where not is_core and doc_type <> 'extracted page snapshot';
  -- An empty or tiny sample would mark nothing (or everything) as common: keep the old list.
  if coalesce(v_total, 0) < 200 then
    return -1;
  end if;
  delete from public.ask_sentinel_common_lexemes where true;
  insert into public.ask_sentinel_common_lexemes (word, ndoc)
  select s.word, s.ndoc
    from ts_stat(format(
           $q$select search from public.ask_sentinel_chunks tablesample system (10) repeatable (%s)
              where not is_core and doc_type <> 'extracted page snapshot'$q$, v_seed)) s
   where s.ndoc >= greatest(5, ceil(v_total * least(greatest(coalesce(p_min_share, 0.08), 0.01), 0.5)));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.refresh_ask_sentinel_common_lexemes(real) from public, anon, authenticated;
grant execute on function public.refresh_ask_sentinel_common_lexemes(real) to service_role;

select public.refresh_ask_sentinel_common_lexemes();

create or replace function public.search_ask_sentinel_chunks_v3(
  p_query text,
  p_limit integer default 45,
  p_include_snapshots boolean default false,
  p_include_core boolean default true
)
returns table(path text, doc_type text, content text, is_core boolean, score real)
language plpgsql
stable
security definer
set search_path = public, pg_temp
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_text text := left(coalesce(p_query, ''), 500);
  v_all tsquery := websearch_to_tsquery('english', v_text);
  v_any tsquery;
  v_rare tsquery;
  v_rare_text text;
begin
  -- Every word ORed, with phrase (<->, <N>) and AND operators turned into OR.
  v_any := nullif(regexp_replace(v_all::text, ' (&|<->|<[0-9]+>) ', ' | ', 'g'), '')::tsquery;
  if v_any is null then
    v_all := null;
  else
    select string_agg(quote_literal(l.lexeme), ' | ')
      into v_rare_text
      from unnest(tsvector_to_array(to_tsvector('english', v_text))) as l(lexeme)
     where position(E'\\' in l.lexeme) = 0
       and not exists (select 1 from public.ask_sentinel_common_lexemes w where w.word = l.lexeme);
    v_rare := coalesce(nullif(v_rare_text, '')::tsquery, v_any);
  end if;

  return query
  with every_word as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c
     where v_all is not null
       and not c.is_core
       and c.doc_type <> 'extracted page snapshot'
       and c.search @@ v_all
     limit 400
  ),
  every_word_snapshots as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c
     where p_include_snapshots
       and v_all is not null
       and c.doc_type = 'extracted page snapshot'
       and c.search @@ v_all
     limit 200
  ),
  any_word as (
    select c.path, c.chunk_index
      from public.ask_sentinel_chunks c
     where v_rare is not null
       and not c.is_core
       and c.doc_type <> 'extracted page snapshot'
       and c.search @@ v_rare
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
           (ts_rank(c.search, v_any)
             + case when c.search @@ v_all then 2 else 0 end
             + case when c.path like '\_\_%' then 0.05 else 0 end)::real as score,
           c.updated_at
      from candidates k
      join public.ask_sentinel_chunks c using (path, chunk_index)
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
end;
$$;
revoke all on function public.search_ask_sentinel_chunks_v3(text, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.search_ask_sentinel_chunks_v3(text, integer, boolean, boolean) to service_role;
