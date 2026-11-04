create table muze_board_internal.board_tool_access (
  board_id uuid primary key references public.shared_boards(id) on delete cascade,
  owner_id text not null,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table muze_board_internal.board_tool_access enable row level security;
revoke all on muze_board_internal.board_tool_access from public, anon, authenticated;

create function muze_board_internal.manage_tool_access(
  operation text, board_id uuid, access_token text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller text := auth.jwt()->>'sub';
  board_owner text;
  created timestamptz;
begin
  if caller is null or length(caller) not between 1 and 128 then
    raise exception 'Sign in to manage tool access.' using errcode = '42501';
  end if;
  if operation is null or operation not in ('status', 'create', 'revoke') then
    raise exception 'Unknown tool access action.' using errcode = '22023';
  end if;
  select owner_id into board_owner from public.shared_boards where id = board_id for update;
  if board_owner is distinct from caller then
    raise exception 'Only the board owner can manage tool access.' using errcode = '42501';
  end if;
  if operation = 'create' then
    if access_token is null or access_token !~ '^muze_[A-Za-z0-9_-]{43}$' then
      raise exception 'Invalid tool access token.' using errcode = '22023';
    end if;
    insert into muze_board_internal.board_tool_access(board_id, owner_id, token_hash)
      values (board_id, caller, encode(sha256(convert_to(access_token, 'UTF8')), 'hex'))
      on conflict on constraint board_tool_access_pkey do update set
        owner_id = excluded.owner_id, token_hash = excluded.token_hash, created_at = clock_timestamp();
  elsif operation = 'revoke' then
    delete from muze_board_internal.board_tool_access a where a.board_id = manage_tool_access.board_id;
  end if;
  select a.created_at into created from muze_board_internal.board_tool_access a
    where a.board_id = manage_tool_access.board_id and a.owner_id = caller;
  return jsonb_build_object('enabled', created is not null, 'createdAt', created);
end;
$$;
revoke all on function muze_board_internal.manage_tool_access(text, uuid, text) from public, anon, authenticated;
grant execute on function muze_board_internal.manage_tool_access(text, uuid, text) to authenticated;

create function public.manage_board_tool_access(operation text, board_id uuid, access_token text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select muze_board_internal.manage_tool_access(operation, board_id, access_token)
$$;
revoke all on function public.manage_board_tool_access(text, uuid, text) from public, anon, authenticated;
grant execute on function public.manage_board_tool_access(text, uuid, text) to authenticated;

-- A bearer token reads only its exact shared scene. Rechecking the current owner
-- invalidates tokens after ownership changes; deleting a board removes its token.
create function muze_board_internal.read_tool_board(board_id uuid, access_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  snapshot jsonb;
begin
  if access_token is null or access_token !~ '^muze_[A-Za-z0-9_-]{43}$' then
    raise exception 'Tool access is unavailable.' using errcode = '42501';
  end if;
  select jsonb_build_object('board', b.scene, 'revision', b.revision, 'updatedAt', b.updated_at)
    into snapshot from public.shared_boards b
    join muze_board_internal.board_tool_access a on a.board_id = b.id and a.owner_id = b.owner_id
    where b.id = read_tool_board.board_id
      and a.token_hash = encode(sha256(convert_to(access_token, 'UTF8')), 'hex');
  if snapshot is null then
    raise exception 'Tool access is unavailable.' using errcode = '42501';
  end if;
  return snapshot;
end;
$$;
revoke all on function muze_board_internal.read_tool_board(uuid, text) from public, anon, authenticated;
grant usage on schema muze_board_internal to anon;
grant execute on function muze_board_internal.read_tool_board(uuid, text) to anon;

create function public.read_board_for_tool(board_id uuid, access_token text)
returns jsonb language sql security invoker set search_path = '' as $$
  select muze_board_internal.read_tool_board(board_id, access_token)
$$;
revoke all on function public.read_board_for_tool(uuid, text) from public, anon, authenticated;
grant execute on function public.read_board_for_tool(uuid, text) to anon;
