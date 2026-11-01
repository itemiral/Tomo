create table public.shared_board_profiles (
  board_id uuid not null references public.shared_boards(id) on delete cascade,
  user_id text not null check (user_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  name text not null check (length(name) between 1 and 80),
  avatar_url text check (length(avatar_url) <= 2048 and avatar_url ~ '^https://(img\.clerk\.com|images\.clerk\.dev)/'),
  muse_name text not null check (length(muse_name) between 1 and 80),
  muse_avatar text check (length(muse_avatar) <= 400000 and muse_avatar ~ '^[A-Za-z0-9+/]+={0,2}$'),
  muse_avatar_version text check (muse_avatar_version ~ '^[a-f0-9]{64}$'),
  muse_sheet boolean not null default true,
  muse_poses smallint not null default 15 check (muse_poses in (9,15)),
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (board_id, user_id),
  check ((muse_avatar is null) = (muse_avatar_version is null))
);

alter table public.shared_board_profiles enable row level security;
revoke all on public.shared_board_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.shared_board_profiles to authenticated;

create policy shared_board_profiles_read on public.shared_board_profiles for select to authenticated
  using (board_id in (select id from public.shared_boards));
create policy shared_board_profiles_insert on public.shared_board_profiles for insert to authenticated
  with check (user_id = (select auth.jwt()->>'sub') and board_id in (select id from public.shared_boards));
create policy shared_board_profiles_update on public.shared_board_profiles for update to authenticated
  using (user_id = (select auth.jwt()->>'sub') and board_id in (select id from public.shared_boards))
  with check (user_id = (select auth.jwt()->>'sub') and board_id in (select id from public.shared_boards));
create policy shared_board_profiles_delete on public.shared_board_profiles for delete to authenticated
  using (user_id = (select auth.jwt()->>'sub') and board_id in (select id from public.shared_boards));
