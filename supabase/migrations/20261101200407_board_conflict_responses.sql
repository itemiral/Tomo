-- Revision conflicts are application decisions, not retryable database failures.
create or replace function muze_board_internal.write_board(
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
        raise exception 'This board changed. Merge the latest edits before saving.' using errcode = 'PT409';
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
create or replace function public.commit_muse_files(changes jsonb, held_leases jsonb default '[]'::jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_owner text := auth.jwt()->>'sub';
  change jsonb;
  held jsonb;
  current_version uuid;
begin
  if current_owner is null or current_owner = '' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 256
     or jsonb_typeof(held_leases) <> 'array' then
    raise exception 'Invalid document changes' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(current_owner, 1947));
  for held in select value from jsonb_array_elements(held_leases) loop
    if not exists (
      select 1 from public.muse_private_leases
      where owner_id = current_owner and resource = held->>'resource'
        and token = (held->>'token')::uuid and expires_at > clock_timestamp()
    ) then
      raise exception 'Worker lease expired' using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(changes)) <>
     (select count(distinct value->>'name') from jsonb_array_elements(changes)) then
    raise exception 'Duplicate document changes' using errcode = '22023';
  end if;
  for change in select value from jsonb_array_elements(changes) loop
    if not (change ? 'expected_version') then
      raise exception 'Expected version required' using errcode = '22023';
    end if;
    select version into current_version from public.muse_private_files
      where owner_id = current_owner and name = change->>'name' for update;
    if current_version is distinct from (change->>'expected_version')::uuid then
      raise exception 'Document changed' using errcode = 'PT409';
    end if;
  end loop;
  for change in select value from jsonb_array_elements(changes) loop
    if change ? 'content' then
      if jsonb_typeof(change->'content') <> 'string' then
        raise exception 'Invalid document content' using errcode = '22023';
      end if;
      insert into public.muse_private_files (owner_id, name, content)
        values (current_owner, change->>'name', change->>'content')
      on conflict (owner_id, name) do update
        set content = excluded.content, version = gen_random_uuid(), updated_at = clock_timestamp();
    end if;
  end loop;
end;
$$;

