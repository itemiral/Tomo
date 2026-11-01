create schema if not exists muze_board_internal;
revoke all on schema muze_board_internal from public, anon, authenticated;

create function muze_board_internal.valid_scene(scene jsonb, board_id uuid)
returns boolean language sql immutable strict set search_path = '' as $$
  select jsonb_typeof(scene) = 'object'
    and octet_length(scene::text) <= 3000000
    and scene->>'id' = board_id::text
    and jsonb_typeof(scene->'name') = 'string' and length(scene->>'name') between 1 and 160
    and jsonb_typeof(scene->'pages') = 'array'
    and case when jsonb_typeof(scene->'pages') = 'array' then jsonb_array_length(scene->'pages') between 1 and 100 else false end
    and not (scene @? '$.**.id ? (@ == "muse-private" || @ == "muse-file-soul" || @ == "muse-file-memory" || @ == "muse-appearance" || @ == "muse-name")')
$$;
revoke all on function muze_board_internal.valid_scene(jsonb, uuid) from public, anon, authenticated;

create table public.shared_boards (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null check (length(owner_id) between 1 and 128),
  name text not null check (length(name) between 1 and 160),
  scene jsonb not null,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  constraint shared_board_scene check (muze_board_internal.valid_scene(scene, id) is true)
);
create index shared_boards_owner on public.shared_boards(owner_id);

create table public.shared_board_members (
  board_id uuid not null references public.shared_boards(id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 128),
  joined_at timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index shared_board_members_user on public.shared_board_members(user_id, board_id);

create table public.shared_board_invites (
  board_id uuid primary key references public.shared_boards(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null
);

alter table public.shared_boards enable row level security;
alter table public.shared_board_members enable row level security;
alter table public.shared_board_invites enable row level security;
revoke all on public.shared_boards, public.shared_board_members, public.shared_board_invites from public, anon, authenticated;
grant select on public.shared_boards, public.shared_board_members to authenticated;

create policy shared_boards_read on public.shared_boards for select to authenticated
  using (owner_id = (select auth.jwt()->>'sub') or id in (
    select board_id from public.shared_board_members where user_id = (select auth.jwt()->>'sub')
  ));
create policy shared_board_members_read on public.shared_board_members for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));
create policy shared_board_invites_private on public.shared_board_invites for select to authenticated
  using (false);

-- This internal entry point owns writes so membership, quotas, and revisions
-- cannot be bypassed by direct table updates. Every branch checks the caller.
create function muze_board_internal.write_board(
  operation text, board_id uuid default null, board_scene jsonb default null,
  expected_revision uuid default null, invite_token text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller text := auth.jwt()->>'sub';
  saved public.shared_boards%rowtype;
  member boolean;
begin
  if caller is null or length(caller) not between 1 and 128 then
    raise exception 'Sign in to open this board.' using errcode = '42501';
  end if;
  if operation not in ('create', 'save', 'invite', 'revoke', 'join') or operation is null then
    raise exception 'Unknown board action.' using errcode = '22023';
  end if;
  if operation = 'create' then
    if board_scene->>'id' = 'muse-private' then
      raise exception 'Your Muse notebook stays private.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(caller, 2848));
    if (select count(*) from public.shared_boards where owner_id = caller) >= 100 then
      raise exception 'You have reached the shared board limit.' using errcode = '54000';
    end if;
    board_id := gen_random_uuid();
    board_scene := jsonb_set(board_scene, '{id}', to_jsonb(board_id::text));
    if muze_board_internal.valid_scene(board_scene, board_id) is not true then
      raise exception 'This board cannot be shared.' using errcode = '22023';
    end if;
    insert into public.shared_boards(id, owner_id, name, scene)
      values (board_id, caller, board_scene->>'name', board_scene) returning * into saved;
  else
    if operation = 'join' then
      perform pg_advisory_xact_lock(hashtextextended(caller, 2848));
    end if;
    select * into saved from public.shared_boards where id = board_id for update;
    if not found then
      raise exception 'This board is unavailable or you do not have access.' using errcode = '42501';
    end if;
    member := saved.owner_id = caller or exists (
      select 1 from public.shared_board_members where shared_board_members.board_id = saved.id and user_id = caller
    );
    if operation = 'join' then
      if not member then
        if invite_token is null or invite_token !~ '^[A-Za-z0-9_-]{43}$' or not exists (
          select 1 from public.shared_board_invites where shared_board_invites.board_id = saved.id
            and token_hash = encode(sha256(convert_to(invite_token, 'UTF8')), 'hex') and expires_at > clock_timestamp()
        ) then
          raise exception 'This invitation has expired or is no longer available.' using errcode = '42501';
        end if;
        if (select count(*) from public.shared_board_members where user_id = caller) >= 100
          or (select count(*) from public.shared_board_members where shared_board_members.board_id = saved.id) >= 99 then
          raise exception 'The shared board membership limit has been reached.' using errcode = '54000';
        end if;
        insert into public.shared_board_members(board_id, user_id) values (saved.id, caller);
      end if;
    elsif operation = 'save' then
      if not member then
        raise exception 'This board is unavailable or you do not have access.' using errcode = '42501';
      end if;
      if expected_revision is distinct from saved.revision then
        raise exception 'This board changed. Merge the latest edits before saving.' using errcode = '40001';
      end if;
      if muze_board_internal.valid_scene(board_scene, board_id) is not true then
        raise exception 'This board cannot be shared.' using errcode = '22023';
      end if;
      update public.shared_boards set scene = board_scene, name = board_scene->>'name',
        revision = gen_random_uuid(), updated_at = clock_timestamp()
        where id = saved.id returning * into saved;
    else
      if saved.owner_id <> caller then
        raise exception 'Only the owner can manage invitations.' using errcode = '42501';
      end if;
      if operation = 'revoke' then
        delete from public.shared_board_invites where shared_board_invites.board_id = saved.id;
      else
        if invite_token is null or invite_token !~ '^[A-Za-z0-9_-]{43}$' then
          raise exception 'Invalid invitation.' using errcode = '22023';
        end if;
        insert into public.shared_board_invites(board_id, token_hash, expires_at)
          values (saved.id, encode(sha256(convert_to(invite_token, 'UTF8')), 'hex'), clock_timestamp() + interval '7 days')
          on conflict on constraint shared_board_invites_pkey do update
            set token_hash = excluded.token_hash, expires_at = excluded.expires_at;
      end if;
      return '{}'::jsonb;
    end if;
  end if;
  return jsonb_build_object('board', saved.scene, 'revision', saved.revision,
    'role', case when saved.owner_id = caller then 'owner' else 'editor' end);
end;
$$;
revoke all on function muze_board_internal.write_board(text, uuid, jsonb, uuid, text) from public, anon, authenticated;
grant usage on schema muze_board_internal to authenticated;
grant execute on function muze_board_internal.write_board(text, uuid, jsonb, uuid, text) to authenticated;

create function public.write_shared_board(
  operation text, board_id uuid default null, board_scene jsonb default null,
  expected_revision uuid default null, invite_token text default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select muze_board_internal.write_board(operation, board_id, board_scene, expected_revision, invite_token)
$$;
revoke all on function public.write_shared_board(text, uuid, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function public.write_shared_board(text, uuid, jsonb, uuid, text) to authenticated;
