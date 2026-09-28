create table if not exists public.training_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  workout_date date not null,
  exercises jsonb not null default '[]'::jsonb check (jsonb_typeof(exercises) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (user_id, workout_date)
);

alter table public.training_sessions enable row level security;

drop policy if exists "Users can read their training sessions" on public.training_sessions;
create policy "Users can read their training sessions"
  on public.training_sessions for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can create their training sessions" on public.training_sessions;
create policy "Users can create their training sessions"
  on public.training_sessions for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their training sessions" on public.training_sessions;
create policy "Users can update their training sessions"
  on public.training_sessions for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their training sessions" on public.training_sessions;
create policy "Users can delete their training sessions"
  on public.training_sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.training_sessions to authenticated;

-- Atomic per-user daily cap to limit accidental OpenAI API spend.
create table if not exists public.ai_recognition_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  requests integer not null default 0 check (requests >= 0),
  primary key (user_id, usage_date)
);
alter table public.ai_recognition_usage enable row level security;

create or replace function public.consume_recognition_quota(p_daily_limit integer default 5)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  insert into public.ai_recognition_usage (user_id, usage_date, requests)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, usage_date) do update
    set requests = public.ai_recognition_usage.requests + 1
    where public.ai_recognition_usage.requests < greatest(1, least(p_daily_limit, 100))
  returning requests into request_count;
  return request_count is not null;
end;
$$;
revoke all on function public.consume_recognition_quota(integer) from public, anon;
grant execute on function public.consume_recognition_quota(integer) to authenticated;



