-- A request protects only referenced shared objects. No chat or private Muse
-- content is stored here, and expired requests never prevent a board write.
create table muze_board_internal.muse_object_leases (
  board_id uuid not null references public.shared_boards(id) on delete cascade,
  request_id uuid not null,
  owner_id text not null check (length(owner_id) between 1 and 128),
  objects jsonb not null check (jsonb_typeof(objects) = 'array'),
  expires_at timestamptz not null,
  deadline timestamptz not null,
  primary key (board_id, request_id)
);
alter table muze_board_internal.muse_object_leases enable row level security;
revoke all on muze_board_internal.muse_object_leases from public, anon, authenticated;
create index muse_object_leases_expiry on muze_board_internal.muse_object_leases(expires_at);

create function muze_board_internal.scene_object_refs(scene jsonb)
returns table(page_id text, object_id text) language sql immutable set search_path = '' as $$
  with recursive objects(page_id, item) as (
    select page->>'id', item from jsonb_array_elements(scene->'pages') page
      cross join lateral jsonb_array_elements(page->'objects') item
    union all
    select objects.page_id, nested from objects
      cross join lateral jsonb_array_elements(case when jsonb_typeof(item->'objects') = 'array' then item->'objects' else '[]'::jsonb end) nested
  ) select distinct page_id, item->>'id' from objects where jsonb_typeof(item->'id') = 'string'
$$;
revoke all on function muze_board_internal.scene_object_refs(jsonb) from public, anon, authenticated;

create function muze_board_internal.board_lease(operation text, board_id uuid, request_id uuid default null, objects jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller text := auth.jwt()->>'sub';
  saved public.shared_boards%rowtype;
  held muze_board_internal.muse_object_leases%rowtype;
  result jsonb;
begin
  if caller is null or length(caller) not between 1 and 128 then raise exception 'Sign in to use this board.' using errcode = '42501'; end if;
  if operation not in ('acquire','renew','release','list') or operation is null then raise exception 'Unknown request action.' using errcode = '22023'; end if;
  -- Acquisition and scene writes serialize on the same row, closing the gap
  -- between checking object existence and protecting it from deletion.
  select * into saved from public.shared_boards where id = board_id for update;
  if not found or not (saved.owner_id = caller or exists(select 1 from public.shared_board_members where shared_board_members.board_id = saved.id and user_id = caller)) then
    raise exception 'This board is unavailable or you do not have access.' using errcode = '42501';
  end if;
  delete from muze_board_internal.muse_object_leases where muse_object_leases.board_id = saved.id and expires_at <= clock_timestamp();
  if operation = 'list' then
    select coalesce(jsonb_agg(jsonb_build_object('pageId', page_id, 'objectId', object_id, 'expiresAt', expires_at)), '[]'::jsonb) into result
    from (select item->>'pageId' page_id, item->>'objectId' object_id, max(leases.expires_at) expires_at
      from muze_board_internal.muse_object_leases leases cross join lateral jsonb_array_elements(leases.objects) item
      where leases.board_id = saved.id and leases.expires_at > clock_timestamp()
      group by item->>'pageId', item->>'objectId') protected;
    return result;
  end if;
  if request_id is null then raise exception 'Invalid request.' using errcode = '22023'; end if;
  select * into held from muze_board_internal.muse_object_leases leases where leases.board_id = saved.id and leases.request_id = board_lease.request_id;
  if found and held.owner_id <> caller then raise exception 'This request belongs to another user.' using errcode = '42501'; end if;
  if operation = 'release' then
    delete from muze_board_internal.muse_object_leases leases where leases.board_id = saved.id and leases.request_id = board_lease.request_id and leases.owner_id = caller;
    return '{}'::jsonb;
  end if;
  if operation = 'renew' then
    if held.request_id is null or held.deadline <= clock_timestamp() then raise exception 'Muse’s request expired. Try again.' using errcode = 'PT409'; end if;
    update muze_board_internal.muse_object_leases leases set expires_at = least(clock_timestamp() + interval '90 seconds', leases.deadline)
      where leases.board_id = saved.id and leases.request_id = board_lease.request_id returning * into held;
    return jsonb_build_object('expiresAt', held.expires_at);
  end if;
  if held.request_id is not null then raise exception 'Muse is already using this request.' using errcode = 'PT409'; end if;
  if jsonb_typeof(objects) is distinct from 'array' or jsonb_array_length(objects) > 30000 or octet_length(objects::text) > 4000000 then
    raise exception 'Too many notes in this request.' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(objects) item where jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'pageId') is distinct from 'string' or jsonb_typeof(item->'objectId') is distinct from 'string'
    or length(item->>'pageId') not between 1 and 100 or length(item->>'objectId') not between 1 and 100) then
    raise exception 'Invalid request notes.' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(objects) item where not exists(select 1 from muze_board_internal.scene_object_refs(saved.scene) ref where ref.page_id = item->>'pageId' and ref.object_id = item->>'objectId')) then
    raise exception 'Some notes changed before Muse started. Reading the board again.' using errcode = 'PT409';
  end if;
  if (select count(*) from muze_board_internal.muse_object_leases leases where leases.board_id = saved.id and owner_id = caller) >= 4 then
    raise exception 'Muse is still working on this board. Try again shortly.' using errcode = '54000';
  end if;
  insert into muze_board_internal.muse_object_leases(board_id,request_id,owner_id,objects,expires_at,deadline)
    values(saved.id,request_id,caller,objects,clock_timestamp()+interval '90 seconds',clock_timestamp()+interval '6 minutes') returning * into held;
  return jsonb_build_object('expiresAt',held.expires_at);
end;
$$;
revoke all on function muze_board_internal.board_lease(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function muze_board_internal.board_lease(text,uuid,uuid,jsonb) to authenticated;
create function public.shared_board_lease(operation text, board_id uuid, request_id uuid default null, objects jsonb default '[]'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select muze_board_internal.board_lease(operation,board_id,request_id,objects)
$$;
revoke all on function public.shared_board_lease(text,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.shared_board_lease(text,uuid,uuid,jsonb) to authenticated;

create function muze_board_internal.protect_muse_objects()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from muze_board_internal.muse_object_leases leases cross join lateral jsonb_array_elements(leases.objects) item
    where leases.board_id = old.id and leases.expires_at > clock_timestamp() and (tg_op = 'DELETE' or not exists (
      select 1 from muze_board_internal.scene_object_refs(new.scene) ref where ref.page_id = item->>'pageId' and ref.object_id = item->>'objectId'
    ))
  ) then raise exception 'Muse is using those notes. Try deleting them after the response finishes.' using errcode = 'PT423'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function muze_board_internal.protect_muse_objects() from public, anon, authenticated;
create trigger protect_active_muse_objects before update of scene or delete on public.shared_boards
  for each row execute function muze_board_internal.protect_muse_objects();

-- Image usage is an owner-private budget record, alongside web-search usage.
alter table public.muse_private_files drop constraint muse_private_files_name_check;
alter table public.muse_private_files add constraint muse_private_files_name_check
  check (name ~ '^(identity\.json|soul\.md|memory\.md|canvas\.json|board\.json|icon\.png|avatar(-previous|-operations)?\.json|(search|image)-usage\.json|(chat|task)-[a-f0-9]{64}\.json)$');
