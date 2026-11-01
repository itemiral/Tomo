create table public.muse_private_files (
  owner_id text not null check (length(owner_id) between 1 and 128),
  name text not null check (name ~ '^(identity\.json|soul\.md|memory\.md|canvas\.json|board\.json|icon\.png|avatar(-previous|-operations)?\.json|search-usage\.json|(chat|task)-[a-f0-9]{64}\.json)$'),
  content text not null check (octet_length(content) <= 60000000),
  version uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, name)
);

create table public.muse_private_leases (
  owner_id text not null check (length(owner_id) between 1 and 128),
  resource text not null check (resource in ('avatar', 'chat')),
  token uuid not null,
  expires_at timestamptz not null,
  primary key (owner_id, resource)
);

alter table public.muse_private_files enable row level security;
alter table public.muse_private_leases enable row level security;

revoke all on public.muse_private_files, public.muse_private_leases from anon, authenticated;
grant select, insert, update, delete on public.muse_private_files, public.muse_private_leases to authenticated;

create policy muse_files_owner on public.muse_private_files
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

create policy muse_leases_owner on public.muse_private_leases
  for all to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));

-- One transaction validates every read before changing any document.
create function public.commit_muse_files(changes jsonb, held_leases jsonb default '[]'::jsonb)
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
      raise exception 'Worker lease expired' using errcode = '40001';
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
      raise exception 'Document changed' using errcode = '40001';
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

create function public.acquire_muse_lease(resource text, lease_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_owner text := auth.jwt()->>'sub';
  claimed uuid;
begin
  if current_owner is null or current_owner = '' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(current_owner, 1947));
  insert into public.muse_private_leases as current_lease (owner_id, resource, token, expires_at)
    values (current_owner, resource, lease_token, clock_timestamp() + interval '300 seconds')
  on conflict on constraint muse_private_leases_pkey do update
    set token = excluded.token, expires_at = excluded.expires_at
    where current_lease.expires_at <= clock_timestamp()
  returning token into claimed;
  return claimed is not null;
end;
$$;

create function public.release_muse_lease(resource text, lease_token uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.muse_private_leases
  where owner_id = (select auth.jwt()->>'sub')
    and resource = $1 and token = $2;
$$;

revoke all on function public.commit_muse_files(jsonb, jsonb) from public, anon;
revoke all on function public.acquire_muse_lease(text, uuid) from public, anon;
revoke all on function public.release_muse_lease(text, uuid) from public, anon;
grant execute on function public.commit_muse_files(jsonb, jsonb) to authenticated;
grant execute on function public.acquire_muse_lease(text, uuid) to authenticated;
grant execute on function public.release_muse_lease(text, uuid) to authenticated;
