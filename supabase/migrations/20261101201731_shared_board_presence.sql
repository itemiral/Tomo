-- Realtime already enables RLS and grants the channel roles SELECT/INSERT.
-- Membership is evaluated through the existing shared_boards read policy.
create policy shared_board_presence_receive
on realtime.messages for select to authenticated
using (
  extension in ('broadcast', 'presence')
  and topic = (select realtime.topic())
  and exists (
    select 1 from public.shared_boards
    where id = (
      select case
        when realtime.topic() ~ '^board:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        then substring(realtime.topic() from 7)::uuid
        else null
      end
    )
  )
);

create policy shared_board_presence_send
on realtime.messages for insert to authenticated
with check (
  extension in ('broadcast', 'presence')
  and topic = (select realtime.topic())
  and exists (
    select 1 from public.shared_boards
    where id = (
      select case
        when realtime.topic() ~ '^board:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        then substring(realtime.topic() from 7)::uuid
        else null
      end
    )
  )
);
