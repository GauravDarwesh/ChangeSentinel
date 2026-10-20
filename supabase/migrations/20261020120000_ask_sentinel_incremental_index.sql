-- Ask Sentinel incremental index.
-- Indexing now runs in GitHub Actions (scripts/ask_sentinel_index.py) after every
-- monitor run, so the edge function never fetches or indexes the repository itself.
-- Chunks are keyed by (path, chunk_index) with a content hash, so each run uploads
-- only what changed instead of rewriting the whole corpus per commit.

create table if not exists public.ask_sentinel_chunks (
  path text not null,
  chunk_index integer not null,
  doc_type text not null,
  is_core boolean not null default false,
  content text not null,
  content_hash text not null,
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', path || ' ' || content)) stored,
  primary key (path, chunk_index)
);
alter table public.ask_sentinel_chunks enable row level security;
revoke all on public.ask_sentinel_chunks from anon, authenticated;
grant all on public.ask_sentinel_chunks to service_role;
create index if not exists ask_sentinel_chunks_search_idx on public.ask_sentinel_chunks using gin (search);

-- Seed from the previous full index so the dashboard keeps answering until the
-- first GitHub Actions run replaces it (md5 matches the indexer's content hash).
insert into public.ask_sentinel_chunks (path, chunk_index, doc_type, is_core, content, content_hash)
select d.path, d.chunk_index, d.doc_type, d.is_core, d.content, md5(d.content)
  from public.ask_sentinel_documents d
  join public.ask_sentinel_index_state s on s.commit_sha = d.repo_sha
on conflict (path, chunk_index) do nothing;

-- Any-word matching ranked by relevance. The old function required every word of the
-- question to appear in one chunk, so most questions only got the core overview.
create or replace function public.search_ask_sentinel_chunks(p_query text, p_limit integer default 45)
returns table(path text, doc_type text, content text, is_core boolean, score real)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select nullif(replace(websearch_to_tsquery('english', left(coalesce(p_query, ''), 500))::text, ' & ', ' | '), '')::tsquery as tsq
  )
  select c.path, c.doc_type, c.content, c.is_core,
         case when c.is_core then 1000::real
              else ts_rank_cd(c.search, q.tsq, 32) + case when c.path like '\_\_%' then 0.05 else 0 end
         end::real as score
    from public.ask_sentinel_chunks c
    cross join q
   where c.is_core or (q.tsq is not null and c.search @@ q.tsq)
   order by c.is_core desc, score desc, c.updated_at desc
   limit least(greatest(coalesce(p_limit, 45), 1), 60);
$$;
revoke all on function public.search_ask_sentinel_chunks(text, integer) from public, anon, authenticated;
grant execute on function public.search_ask_sentinel_chunks(text, integer) to service_role;

-- The legacy full-rewrite table is dropped by a follow-up migration once the
-- GitHub Actions indexer has run successfully.
