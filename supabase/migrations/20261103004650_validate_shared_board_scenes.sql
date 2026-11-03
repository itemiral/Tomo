-- The public RPC is callable directly, so scene validity must also hold in SQL.
-- These helpers remain internal and do not change board ownership or membership.
create function muze_board_internal.text_units(value text)
returns integer language sql immutable strict set search_path = '' as $$
  select length(value) + length(regexp_replace(value, '[^' || chr(65536) || '-' || chr(1114111) || ']', '', 'g'))
$$;

create function muze_board_internal.valid_number(value jsonb, maximum numeric default 1000000)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'number' then abs((value #>> '{}')::numeric) <= maximum else false end
$$;

create function muze_board_internal.valid_color(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select value is null or value = 'null'::jsonb or
    (jsonb_typeof(value) = 'string' and (value #>> '{}') ~* '^(#[0-9a-f]{3,8}|rgba?\([0-9.,% ]+\)|transparent|none|black|white|)$')
$$;

create function muze_board_internal.valid_text_style(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare field text;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  foreach field in array array['fill','stroke','textBackgroundColor','textDecorationColor'] loop
    if not muze_board_internal.valid_color(value->field) then return false; end if;
  end loop;
  if value ? 'fontFamily' and (jsonb_typeof(value->'fontFamily') is distinct from 'string' or (value->>'fontFamily') !~ '^[A-Za-z0-9_ ,''-]{1,100}$') then return false; end if;
  foreach field in array array['fontSize','deltaY','strokeWidth'] loop
    if value ? field and not muze_board_internal.valid_number(value->field) then return false; end if;
  end loop;
  return true;
end;
$$;

create function muze_board_internal.valid_https_reference(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare reference text; authority text; host text; suffix text; address inet;
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  reference := value #>> '{}';
  if muze_board_internal.text_units(reference) > 2048 or reference !~* '^https://' then return false; end if;
  authority := regexp_replace(substring(reference from 9),'[/#?].*$','','s');
  if authority = '' or authority ~ '[@[:space:]\\]' then return false; end if;
  if left(authority,1) = '[' then
    if strpos(authority,']') = 0 then return false; end if;
    host := substring(authority from 2 for strpos(authority,']')-2);
    suffix := substring(authority from strpos(authority,']')+1);
    begin
      address := host::inet;
      if family(address) <> 6 or strpos(host,'/') > 0 then return false; end if;
    exception when invalid_text_representation then return false;
    end;
  else
    host := split_part(authority,':',1);
    suffix := substring(authority from length(host)+1);
    if host = '' or host ~ '[<>^|\[\]]' then return false; end if;
  end if;
  if suffix <> '' then
    if suffix !~ '^:0*[0-9]{0,5}$' then return false; end if;
    if length(suffix) > 1 and substring(suffix from 2)::integer > 65535 then return false; end if;
  end if;
  return true;
end;
$$;

create function muze_board_internal.valid_drawing_object(value jsonb, depth integer default 0)
returns boolean language plpgsql immutable set search_path = '' as $$
declare field text; child jsonb; part jsonb; style jsonb; command text; expected integer;
begin
  if depth > 12 or jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if jsonb_typeof(value->'type') is distinct from 'string' or not ((value->>'type') = any(array['Rect','Ellipse','Triangle','Polygon','Polyline','Line','Path','Textbox','IText','Text','Group','Image','MuzeArrow','MuzeNote','MuzeDocument','MuzeText','MuzeLabel','MuzeShape'])) then return false; end if;
  if value ? 'id' and (jsonb_typeof(value->'id') is distinct from 'string' or muze_board_internal.text_units(value->>'id') not between 1 and 160) then return false; end if;
  foreach field in array array['left','top','width','height','scaleX','scaleY','angle','opacity','strokeWidth','fontSize','bend','boxHeight','inset'] loop
    if value ? field and not muze_board_internal.valid_number(value->field) then return false; end if;
  end loop;
  if value ? 'muzeLeading' then
    if not muze_board_internal.valid_number(value->'muzeLeading',2) then return false; end if;
    if (value->>'muzeLeading')::numeric < 1 then return false; end if;
  end if;
  if not muze_board_internal.valid_text_style(value) or not muze_board_internal.valid_color(value->'backgroundColor') then return false; end if;
  foreach field in array array['sourceUrl','imageUrl'] loop
    if value ? field and muze_board_internal.valid_https_reference(value->field) is not true then return false; end if;
  end loop;
  foreach field in array array['attribution','sourceTitle','documentTitle','markdown','text'] loop
    if value ? field then
      if jsonb_typeof(value->field) is distinct from 'string' then return false; end if;
      expected := case field when 'attribution' then 1100 when 'sourceTitle' then 200 when 'documentTitle' then 160 when 'markdown' then 512000 else case when value->>'type' = 'MuzeDocument' then 520000 else 100000 end end;
      if muze_board_internal.text_units(value->>field) > expected then return false; end if;
    end if;
  end loop;
  if value ? 'src' and (jsonb_typeof(value->'src') is distinct from 'string' or (value->>'src') !~* '^data:image/(png|jpeg|webp|gif);base64,') then return false; end if;
  if value ? 'path' and value->'path' <> 'null'::jsonb then
    if jsonb_typeof(value->'path') is distinct from 'array' then return false; end if;
    if jsonb_array_length(value->'path') > 100000 then return false; end if;
    for part in select item from jsonb_array_elements(value->'path') as parts(item) loop
      if jsonb_typeof(part) is distinct from 'array' or jsonb_typeof(part->0) is distinct from 'string' then return false; end if;
      command := upper(part->>0);
      expected := case command when 'M' then 3 when 'L' then 3 when 'H' then 2 when 'V' then 2 when 'C' then 7 when 'S' then 5 when 'Q' then 5 when 'T' then 3 when 'A' then 8 when 'Z' then 1 else 0 end;
      if expected = 0 or jsonb_array_length(part) <> expected then return false; end if;
      if exists(select 1 from jsonb_array_elements(part) with ordinality as parameters(item,position) where position > 1 and not muze_board_internal.valid_number(item)) then return false; end if;
    end loop;
  end if;
  if value ? 'points' then
    if jsonb_typeof(value->'points') is distinct from 'array' then return false; end if;
    if jsonb_array_length(value->'points') > 100000 then return false; end if;
    for part in select item from jsonb_array_elements(value->'points') as points(item) loop
      if jsonb_typeof(part) is distinct from 'object' or not muze_board_internal.valid_number(part->'x') or not muze_board_internal.valid_number(part->'y') then return false; end if;
    end loop;
  end if;
  if value ? 'styles' then
    if jsonb_typeof(value->'styles') = 'array' then
      for style in select item from jsonb_array_elements(value->'styles') as styles(item) loop
        if jsonb_typeof(style) is distinct from 'object' or not muze_board_internal.valid_number(style->'start') or not muze_board_internal.valid_number(style->'end') or not muze_board_internal.valid_text_style(style->'style') then return false; end if;
      end loop;
    elsif jsonb_typeof(value->'styles') = 'object' then
      for part in select item from jsonb_each(value->'styles') as lines(key,item) loop
        if jsonb_typeof(part) is distinct from 'object' then return false; end if;
        for style in select item from jsonb_each(part) as styles(key,item) loop
          if not muze_board_internal.valid_text_style(style) then return false; end if;
        end loop;
      end loop;
    else return false;
    end if;
  end if;
  if value ? 'shadow' and value->'shadow' not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) then
    if jsonb_typeof(value->'shadow') is distinct from 'object' or not muze_board_internal.valid_color(value->'shadow'->'color') then return false; end if;
  end if;
  foreach field in array array['clipPath','resizeFilter'] loop
    if value ? field and value->field not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) then return false; end if;
  end loop;
  if value ? 'filters' then
    if jsonb_typeof(value->'filters') is distinct from 'array' then return false; end if;
    if jsonb_array_length(value->'filters') <> 0 then return false; end if;
  end if;
  if value ? 'objects' then
    if jsonb_typeof(value->'objects') is distinct from 'array' then return false; end if;
    if jsonb_array_length(value->'objects') >= 10000 then return false; end if;
    for child in select item from jsonb_array_elements(value->'objects') as children(item) loop
      if not muze_board_internal.valid_drawing_object(child,depth+1) then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;

create or replace function muze_board_internal.valid_scene(scene jsonb, board_id uuid)
returns boolean language plpgsql immutable strict set search_path = '' as $$
declare page jsonb; drawing jsonb; comment jsonb; field text; page_ids text[] := '{}'; comment_ids text[] := '{}';
begin
  if jsonb_typeof(scene) is distinct from 'object' or octet_length(scene::text) > 3000000 or scene->>'id' is distinct from board_id::text then return false; end if;
  if jsonb_typeof(scene->'name') is distinct from 'string' or muze_board_internal.text_units(scene->>'name') not between 1 and 160 or scene->>'name' ~ '^[[:space:]]*$' then return false; end if;
  if jsonb_typeof(scene->'pages') is distinct from 'array' then return false; end if;
  if jsonb_array_length(scene->'pages') not between 1 and 100 then return false; end if;
  if scene @? '$.**.id ? (@ == "muse-private" || @ == "muse-file-soul" || @ == "muse-file-memory" || @ == "muse-appearance" || @ == "muse-name")' then return false; end if;
  for page in select item from jsonb_array_elements(scene->'pages') as pages(item) loop
    if jsonb_typeof(page) is distinct from 'object' or jsonb_typeof(page->'id') is distinct from 'string' or muze_board_internal.text_units(page->>'id') not between 1 and 160 or (page->>'id') = any(page_ids) then return false; end if;
    page_ids := array_append(page_ids,page->>'id');
    if jsonb_typeof(page->'name') is distinct from 'string' or muze_board_internal.text_units(page->>'name') > 160 or jsonb_typeof(page->'objects') is distinct from 'array' or jsonb_typeof(page->'viewport') is distinct from 'array' then return false; end if;
    if jsonb_array_length(page->'objects') > 10000 or jsonb_array_length(page->'viewport') <> 6 then return false; end if;
    if exists(select 1 from jsonb_array_elements(page->'viewport') as transform(item) where not muze_board_internal.valid_number(item,1.7976931348623157e308)) then return false; end if;
    if (page->'viewport'->>0)::numeric not between 0.1 and 8 then return false; end if;
    for drawing in select item from jsonb_array_elements(page->'objects') as drawings(item) loop
      if not (drawing ? 'id') or not muze_board_internal.valid_drawing_object(drawing) then return false; end if;
    end loop;
    if (with recursive objects(item) as (
      select item from jsonb_array_elements(page->'objects') as roots(item)
      union all select child from objects cross join lateral jsonb_array_elements(coalesce(objects.item->'objects','[]'::jsonb)) as children(child)
    ) select count(*) <> count(distinct item->>'id') from objects where item ? 'id') then return false; end if;
  end loop;
  if scene ? 'comments' then
    if jsonb_typeof(scene->'comments') is distinct from 'array' then return false; end if;
    if jsonb_array_length(scene->'comments') > 100 then return false; end if;
    for comment in select item from jsonb_array_elements(scene->'comments') as comments(item) loop
      if jsonb_typeof(comment) is distinct from 'object' or jsonb_typeof(comment->'id') is distinct from 'string' or muze_board_internal.text_units(comment->>'id') not between 1 and 160 or (comment->>'id') = any(comment_ids) then return false; end if;
      comment_ids := array_append(comment_ids,comment->>'id');
      if jsonb_typeof(comment->'text') is distinct from 'string' or muze_board_internal.text_units(comment->>'text') > 4000 or jsonb_typeof(comment->'author') is distinct from 'string' then return false; end if;
      if comment ? 'pageId' and jsonb_typeof(comment->'pageId') is distinct from 'string' then return false; end if;
      foreach field in array array['x','y'] loop
        if comment ? field and not muze_board_internal.valid_number(comment->field,1.7976931348623157e308) then return false; end if;
      end loop;
    end loop;
  end if;
  return true;
end;
$$;

revoke all on function muze_board_internal.text_units(text),
  muze_board_internal.valid_number(jsonb,numeric), muze_board_internal.valid_color(jsonb),
  muze_board_internal.valid_text_style(jsonb), muze_board_internal.valid_https_reference(jsonb),
  muze_board_internal.valid_drawing_object(jsonb,integer) from public, anon, authenticated;
