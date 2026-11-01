-- public.rls_auto_enable() is the event-trigger function behind ensure_rls (it enables
-- RLS on every new public table). It is SECURITY DEFINER and, like every function in
-- public, was executable by anon and authenticated over /rest/v1/rpc (Supabase advisor
-- lints 0028/0029, 1 Nov 2026). An event-trigger function cannot run outside its
-- trigger, but nothing should be callable through the API that is not meant to be.
-- Event triggers fire as the function's owner, so ensure_rls keeps working.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
