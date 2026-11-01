create table if not exists public.ask_sentinel_usage (
  user_id uuid not null,
  usage_date date not null,
  request_count integer not null default 0 check (request_count >= 0 and request_count <= 3),
  primary key (user_id, usage_date)
);
alter table public.ask_sentinel_usage enable row level security;
revoke all on public.ask_sentinel_usage from anon, authenticated;
grant all on public.ask_sentinel_usage to service_role;

create table if not exists public.ask_sentinel_documents (
  id text primary key,
  repo_sha text not null,
  path text not null,
  chunk_index integer not null default 0,
  doc_type text not null,
  is_core boolean not null default false,
  content text not null,
  updated_at timestamptz not null default now()
);
alter table public.ask_sentinel_documents enable row level security;
revoke all on public.ask_sentinel_documents from anon, authenticated;
grant all on public.ask_sentinel_documents to service_role;
create index if not exists ask_sentinel_documents_repo_sha_idx on public.ask_sentinel_documents (repo_sha);
create index if not exists ask_sentinel_documents_search_idx on public.ask_sentinel_documents
  using gin (to_tsvector('english', path || ' ' || content));

create table if not exists public.ask_sentinel_index_state (
  repository text primary key,
  commit_sha text not null,
  indexed_at timestamptz not null default now(),
  document_count integer not null default 0
);
alter table public.ask_sentinel_index_state enable row level security;
revoke all on public.ask_sentinel_index_state from anon, authenticated;
grant all on public.ask_sentinel_index_state to service_role;

create or replace function public.consume_ask_sentinel_request(p_user_id uuid, p_usage_date date)
returns table(allowed boolean, remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.ask_sentinel_usage as u (user_id, usage_date, request_count)
  values (p_user_id, p_usage_date, 1)
  on conflict (user_id, usage_date) do update
    set request_count = u.request_count + 1
    where u.request_count < 3
  returning request_count into v_count;

  if not found then
    return query select false, 0;
    return;
  end if;
  return query select true, greatest(0, 3 - v_count);
end;
$$;
revoke all on function public.consume_ask_sentinel_request(uuid, date) from public, anon, authenticated;
grant execute on function public.consume_ask_sentinel_request(uuid, date) to service_role;

create or replace function public.search_ask_sentinel_documents(p_query text, p_repo_sha text, p_limit integer default 30)
returns table(path text, doc_type text, content text, is_core boolean, score real)
language sql
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select websearch_to_tsquery('english', left(coalesce(p_query, ''), 500)) as tsq
  )
  select d.path,
         d.doc_type,
         d.content,
         d.is_core,
         case when d.is_core then 1000::real else ts_rank_cd(to_tsvector('english', d.path || ' ' || d.content), q.tsq) end as score
    from public.ask_sentinel_documents d
    cross join q
   where d.repo_sha = p_repo_sha
     and (
       d.is_core
       or to_tsvector('english', d.path || ' ' || d.content) @@ q.tsq
       or (length(left(coalesce(p_query, ''), 180)) >= 12 and d.path ilike '%' || left(p_query, 180) || '%')
     )
   order by d.is_core desc,
            score desc,
            d.updated_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 45);
$$;
revoke all on function public.search_ask_sentinel_documents(text, text, integer) from public, anon, authenticated;
grant execute on function public.search_ask_sentinel_documents(text, text, integer) to service_role;
