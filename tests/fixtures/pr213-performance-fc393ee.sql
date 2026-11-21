begin;
set local lock_timeout='1s';
set local statement_timeout='5s';

-- Cache pure expansions, never authorization, readiness, ownership or membership.
-- A changed input has a different key; active retained terms are read on EVERY
-- send. Workspace deletion removes its private cached data as well.
create table if not exists app.private_dispatch_alias_cache (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 revision bytea not null,
 input_kind text not null check(input_kind in ('generic','party','origin')),
 input_hash bytea not null,
 input_value text not null,
 aliases text[] not null,
 primary key(workspace_id,revision,input_kind,input_hash)
);
alter table app.private_dispatch_alias_cache enable row level security;
revoke all on app.private_dispatch_alias_cache from public,anon,authenticated,service_role;

create or replace function app.private_dispatch_aliases(p_workspace_id uuid,p_value text,p_kind text,p_revision bytea,p_write boolean) returns text[]
language plpgsql security definer set search_path='' set enable_seqscan=off as $memo$
declare digest bytea;remembered text;keys text[];
begin
 if p_value is null then return array[]::text[];end if;
 if p_kind in ('generic','party') then p_value:=app.private_invoice_normalize(p_value);end if;
 if p_kind='origin' and app.private_invoice_decode_json(p_value) is not null then return array[]::text[];end if;
 if p_kind='origin' and not app.private_invoice_has_origin(p_value) then return array[]::text[];end if;
 if p_kind in ('party','origin') and p_value ~ '^[0-9 .,;:/+()''-]+$' then return array[]::text[];end if;
 if p_value ~ '^[0-9]+$' then
  if p_kind in ('party','origin') then return array[]::text[];end if;
  if p_kind='generic' then return array(select * from app.private_invoice_term_aliases(p_value));end if;
 end if;
 if p_kind='generic' and p_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  return case when p_value ~ '[a-f]' then array[p_value,'identifier:'||replace(p_value,'-','')] else array[p_value] end;
 end if;
 digest:=sha256(convert_to(p_value,'UTF8'));
 select input_value,aliases into remembered,keys from app.private_dispatch_alias_cache
 where workspace_id=p_workspace_id and revision=p_revision and input_kind=p_kind and input_hash=digest;
 if found then
  if remembered is distinct from p_value then raise exception 'PRIVATE_DISPATCH_CACHE_COLLISION';end if;
  return keys;
 end if;
 case p_kind
 when 'generic' then keys:=array(select * from app.private_invoice_term_aliases(p_value));
 when 'party' then keys:=array(select * from app.private_invoice_party_aliases(p_value));
 when 'origin' then keys:=array(select * from app.private_invoice_origin_aliases(p_value));
 else raise exception 'INVALID_PRIVATE_DISPATCH_CACHE_KIND';
 end case;
 if p_write and p_workspace_id is not null then
  insert into app.private_dispatch_alias_cache(workspace_id,revision,input_kind,input_hash,input_value,aliases)
  select p_workspace_id,p_revision,p_kind,digest,p_value,keys where exists(select 1 from public.workspaces where id=p_workspace_id)
  on conflict do nothing;
 end if;
 return keys;
end $memo$;
revoke all on function app.private_dispatch_aliases(uuid,text,text,bytea,boolean) from public,anon,authenticated,service_role;


-- Literal, reviewable replacements; no source-text rewriting at migration time.
CREATE OR REPLACE FUNCTION app.private_invoice_term_aliases(p_term text)
 RETURNS SETOF text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  term text:=app.private_invoice_normalize(p_term);parts text[];y integer;m integer;day integer;d date;candidate integer[];
  ordinals text[]:=string_to_array('first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first',',');month_pattern text:='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  day_pattern text;day_text text;month_text text;canonical text;date_term text;has_dates boolean:=false;has_numeric boolean:=false;has_words boolean:=false;
  candidates integer[][]:=array[]::integer[][];scan text;pattern text;token text[];cursor_at integer;a integer;b integer;span record;calendar record;shared_keys text[];
begin
  if length(term)=0 then return;end if;
  if length(term)>4000 then
    return query select * from app.private_invoice_numeric_candidates(term,false);if found then return;end if;
    scan:=app.private_invoice_lexical(term);
    -- Intrinsic and explicitly monetary fields own their spans before dates.
    for span in select * from app.private_invoice_origin_numbers(scan) loop
      if span.value ~ '(?<![a-z0-9_])[0-9]+ +[0-9]+ */ *[0-9]+(?:[kmb])?(?![a-z0-9_]| *[/.-] *[0-9])' or left(scan,span.first_at-1) !~ '(?<![a-z0-9_])(?:due(?: +date)?|invoice +date|date)(?![a-z0-9_]) *(?:(?:is|was|to)(?![a-z0-9_]) *)?[:=]? *$' and (left(scan,span.first_at-1) ~ U&'(?<![a-z0-9_])(?:total|subtotal|tax|amount|balance|price|rate|quantity)(?![a-z0-9_]) *(?:(?:is|was|are|were|to)(?![a-z0-9_]) *)?[:=]? *(?:(?:(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs\\.?|rupees?|dollars?|euros?|pounds?)|[\0024\00a2-\00a5\058f\060b\07fe-\07ff\09f2-\09f3\09fb\0af1\0bf9\0e3f\17db\20a0-\20c1\a838\fdfc\fe69\ff04\ffe0-\ffe1\ffe5-\ffe6\+011fdd-\+011fe0\+01e2ff\+01ecb0]) *)?[+−-]? *$' or span.value ~ U&'(?:[\0024\00a2-\00a5\058f\060b\07fe-\07ff\09f2-\09f3\09fb\0af1\0bf9\0e3f\17db\20a0-\20c1\a838\fdfc\fe69\ff04\ffe0-\ffe1\ffe5-\ffe6\+011fdd-\+011fe0\+01e2ff\+01ecb0]|(?<![a-z0-9_])(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs\\.?|rupees?|dollars?|euros?|pounds?)) *$' or span.value ~ U&'^ *(?:[\0024\00a2-\00a5\058f\060b\07fe-\07ff\09f2-\09f3\09fb\0af1\0bf9\0e3f\17db\20a0-\20c1\a838\fdfc\fe69\ff04\ffe0-\ffe1\ffe5-\ffe6\+011fdd-\+011fe0\+01e2ff\+01ecb0]|(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs\\.?|rupees?|dollars?|euros?|pounds?)(?![a-z0-9_]))') then
        return query select * from app.private_invoice_numeric_candidates(span.value,span.enumeration);return query select * from app.private_invoice_word_number_aliases(span.value);
        scan:=overlay(scan placing repeat(' ',span.last_at-span.first_at) from span.first_at for span.last_at-span.first_at);
      end if;
    end loop;
    for calendar in select * from app.private_invoice_date_spans(scan) loop
      a:=calendar.first_at;b:=calendar.last_at;
      if calendar.value ~ '^[0-9 ./-]+$' and substring(scan from b) ~ '^ *(?:thousand|lakh|lac|million|crore|billion|trillion|quadrillion|quintillion|k|m|b|hundred)(?![a-z])' then continue;end if;
      return query select unnest(calendar.date_keys);
      if app.private_invoice_calendar_exclusive(scan,a,b) then scan:=overlay(scan placing repeat(' ',b-a) from a for b-a);end if;
    end loop;
    for span in select * from app.private_invoice_origin_numbers(scan) loop
      return query select * from app.private_invoice_numeric_candidates(span.value,span.enumeration);
      return query select * from app.private_invoice_word_number_aliases(span.value);
    end loop;return;
  end if;
  return next term;
  -- UUIDs have no scalar/date/word-number interpretation.
  if term ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    if term ~ '[a-f]' then return next 'identifier:'||replace(term,'-','');end if;return;
  end if;
  if term ~ '^[0-9]+$' then return query select * from app.private_invoice_numeric_candidates(term,false);return;end if;

  shared_keys:=array(select distinct unnest(g.date_keys) from app.private_invoice_shared_calendar(app.private_invoice_lexical(term))g where g.first_at=1 and g.last_at=length(app.private_invoice_lexical(term))+1);
  if cardinality(shared_keys)>0 then return query select unnest(shared_keys);return;end if;
  term:=regexp_replace(term,U&'^[\0022\0027\00ab\00bb\2018-\201f\2039-\203a\2e42\300c-\300f\301d-\301f\fe41-\fe44\ff02\ff07\ff62-\ff63\02bc]+|[\0022\0027\00ab\00bb\2018-\201f\2039-\203a\2e42\300c-\300f\301d-\301f\fe41-\fe44\ff02\ff07\ff62-\ff63\02bc]+$','','g');
  if term ~ '[0-9]' and not (term ~ '^[0-9]{1,2} */ *[0-9]{1,2}$') then return query select * from app.private_invoice_numeric_candidates(term,false);has_numeric:=found;end if;
  return query select * from app.private_invoice_word_number_aliases(term);has_words:=found;
  if term !~ '^[0-9, ''kmb]+$' then
  date_term:=app.private_invoice_lexical(regexp_replace(term,'[., ]+$',''));
  if date_term ~ '^(?:[0-9]|the +|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty|thirtieth|thirty)' then
  parts:=regexp_match(date_term,'^([0-9]{4}) *[./-] *([0-9]{1,2}) *[./-] *([0-9]{1,2})$');
  if parts is not null then candidates:=array[array[parts[1]::integer,parts[2]::integer,parts[3]::integer]];
  else
    parts:=regexp_match(date_term,'^([0-9]{1,2}) *[./-] *([0-9]{1,2})(?: *[./-] *([0-9]{4}|[0-9]{2}))?$');
    if parts is not null then
      y:=parts[3]::integer;
      if length(parts[3])=2 then y:=y+case when y<=69 then 2000 else 1900 end;end if;
      candidates:=array[array[y,parts[2]::integer,parts[1]::integer],array[y,parts[1]::integer,parts[2]::integer]];
    else
      parts:=regexp_match(date_term,'^(?:the +)?((?:[0-9]{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[ -]+first|twenty[ -]+second|twenty[ -]+third|twenty[ -]+fourth|twenty[ -]+fifth|twenty[ -]+sixth|twenty[ -]+seventh|twenty[ -]+eighth|twenty[ -]+ninth|thirtieth|thirty[ -]+first))[ ./-]*(?:of +)?((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))(?:[ ,./-]*[''’ʼ]? *([0-9]+)|(?![ ,./-]*[''’ʼ]? *[0-9]))$');
      if parts is not null then day_text:=parts[1];month_text:=parts[2];if length(parts[3])>4 then parts:=null;else y:=parts[3]::integer;end if;
      else
        parts:=regexp_match(date_term,'^((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))[ ./-]*(?:the +)?((?:[0-9]{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[ -]+first|twenty[ -]+second|twenty[ -]+third|twenty[ -]+fourth|twenty[ -]+fifth|twenty[ -]+sixth|twenty[ -]+seventh|twenty[ -]+eighth|twenty[ -]+ninth|thirtieth|thirty[ -]+first))(?:[ ,./-]*[''’ʼ]? *([0-9]+)|(?![ ,./-]*[''’ʼ]? *[0-9]))$');
        if parts is not null then month_text:=parts[1];day_text:=parts[2];if length(parts[3])>4 then parts:=null;else y:=parts[3]::integer;end if;end if;
      end if;
      if parts is not null then
        if length(parts[3])=2 then y:=y+case when y<=69 then 2000 else 1900 end;end if;
        m:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],left(month_text,3));
        if day_text ~ '^[0-9]' then day:=regexp_replace(day_text,'(st|nd|rd|th)$','')::integer;
        else day:=array_position(ordinals,regexp_replace(day_text,'[ -]+',' ','g'));end if;
        candidates:=array[array[y,m,day]];
      end if;
    end if;
  end if;
  if cardinality(candidates)>0 then
  foreach candidate slice 1 in array candidates loop
    y:=candidate[1];m:=candidate[2];day:=candidate[3];
    begin d:=make_date(coalesce(y,2000),m,day);exception when datetime_field_overflow or invalid_datetime_format then continue;end;
    has_dates:=true;return next 'date:'||case when y is null then '*' else lpad(y::text,4,'0') end||to_char(d,'-MM-DD');
  end loop;
  end if;
  end if;
  end if;
  -- Identifier aliases contain no separator-dependent spelling. SQL uses the
  -- same normalized alphanumeric characters; JS inserts separator wildcards.
  if not has_dates and not has_numeric and not has_words then
    if octet_length(term)=length(term) then
      if term ~ '[a-z]' and term !~ U&'[^\0021-\0023\0025-\002a\002c-\003b\003f-\\\005d\005f\0061-\007b\007d ]' then
        return next 'identifier:'||regexp_replace(replace(term,'&','and'),'[^a-z0-9]','','g');
      end if;
    elsif term ~ U&'[\0041-\005a\0061-\007a\00aa\00b5\00ba\00c0-\00d6\00d8-\00f6\00f8-\02c1\02c6-\02d1\02e0-\02e4\02ec\02ee\0370-\0374\0376-\0377\037a-\037d\037f\0386\0388-\038a\038c\038e-\03a1\03a3-\03f5\03f7-\0481\048a-\052f\0531-\0556\0559\0560-\0588\05d0-\05ea\05ef-\05f2\0620-\064a\066e-\066f\0671-\06d3\06d5\06e5-\06e6\06ee-\06ef\06fa-\06fc\06ff\0710\0712-\072f\074d-\07a5\07b1\07ca-\07ea\07f4-\07f5\07fa\0800-\0815\081a\0824\0828\0840-\0858\0860-\086a\0870-\0887\0889-\088f\08a0-\08c9\0904-\0939\093d\0950\0958-\0961\0971-\0980\0985-\098c\098f-\0990\0993-\09a8\09aa-\09b0\09b2\09b6-\09b9\09bd\09ce\09dc-\09dd\09df-\09e1\09f0-\09f1\09fc\0a05-\0a0a\0a0f-\0a10\0a13-\0a28\0a2a-\0a30\0a32-\0a33\0a35-\0a36\0a38-\0a39\0a59-\0a5c\0a5e\0a72-\0a74\0a85-\0a8d\0a8f-\0a91\0a93-\0aa8\0aaa-\0ab0\0ab2-\0ab3\0ab5-\0ab9\0abd\0ad0\0ae0-\0ae1\0af9\0b05-\0b0c\0b0f-\0b10\0b13-\0b28\0b2a-\0b30\0b32-\0b33\0b35-\0b39\0b3d\0b5c-\0b5d\0b5f-\0b61\0b71\0b83\0b85-\0b8a\0b8e-\0b90\0b92-\0b95\0b99-\0b9a\0b9c\0b9e-\0b9f\0ba3-\0ba4\0ba8-\0baa\0bae-\0bb9\0bd0\0c05-\0c0c\0c0e-\0c10\0c12-\0c28\0c2a-\0c39\0c3d\0c58-\0c5a\0c5c-\0c5d\0c60-\0c61\0c80\0c85-\0c8c\0c8e-\0c90\0c92-\0ca8\0caa-\0cb3\0cb5-\0cb9\0cbd\0cdc-\0cde\0ce0-\0ce1\0cf1-\0cf2\0d04-\0d0c\0d0e-\0d10\0d12-\0d3a\0d3d\0d4e\0d54-\0d56\0d5f-\0d61\0d7a-\0d7f\0d85-\0d96\0d9a-\0db1\0db3-\0dbb\0dbd\0dc0-\0dc6\0e01-\0e30\0e32-\0e33\0e40-\0e46\0e81-\0e82\0e84\0e86-\0e8a\0e8c-\0ea3\0ea5\0ea7-\0eb0\0eb2-\0eb3\0ebd\0ec0-\0ec4\0ec6\0edc-\0edf\0f00\0f40-\0f47\0f49-\0f6c\0f88-\0f8c\1000-\102a\103f\1050-\1055\105a-\105d\1061\1065-\1066\106e-\1070\1075-\1081\108e\10a0-\10c5\10c7\10cd\10d0-\10fa\10fc-\1248\124a-\124d\1250-\1256\1258\125a-\125d\1260-\1288\128a-\128d\1290-\12b0\12b2-\12b5\12b8-\12be\12c0\12c2-\12c5\12c8-\12d6\12d8-\1310\1312-\1315\1318-\135a\1380-\138f\13a0-\13f5\13f8-\13fd\1401-\166c\166f-\167f\1681-\169a\16a0-\16ea\16f1-\16f8\1700-\1711\171f-\1731\1740-\1751\1760-\176c\176e-\1770\1780-\17b3\17d7\17dc\1820-\1878\1880-\1884\1887-\18a8\18aa\18b0-\18f5\1900-\191e\1950-\196d\1970-\1974\1980-\19ab\19b0-\19c9\1a00-\1a16\1a20-\1a54\1aa7\1b05-\1b33\1b45-\1b4c\1b83-\1ba0\1bae-\1baf\1bba-\1be5\1c00-\1c23\1c4d-\1c4f\1c5a-\1c7d\1c80-\1c8a\1c90-\1cba\1cbd-\1cbf\1ce9-\1cec\1cee-\1cf3\1cf5-\1cf6\1cfa\1d00-\1dbf\1e00-\1f15\1f18-\1f1d\1f20-\1f45\1f48-\1f4d\1f50-\1f57\1f59\1f5b\1f5d\1f5f-\1f7d\1f80-\1fb4\1fb6-\1fbc\1fbe\1fc2-\1fc4\1fc6-\1fcc\1fd0-\1fd3\1fd6-\1fdb\1fe0-\1fec\1ff2-\1ff4\1ff6-\1ffc\2071\207f\2090-\209c\2102\2107\210a-\2113\2115\2119-\211d\2124\2126\2128\212a-\212d\212f-\2139\213c-\213f\2145-\2149\214e\2183-\2184\2c00-\2ce4\2ceb-\2cee\2cf2-\2cf3\2d00-\2d25\2d27\2d2d\2d30-\2d67\2d6f\2d80-\2d96\2da0-\2da6\2da8-\2dae\2db0-\2db6\2db8-\2dbe\2dc0-\2dc6\2dc8-\2dce\2dd0-\2dd6\2dd8-\2dde\2e2f\3005-\3006\3031-\3035\303b-\303c\3041-\3096\309d-\309f\30a1-\30fa\30fc-\30ff\3105-\312f\3131-\318e\31a0-\31bf\31f0-\31ff\3400-\4dbf\4e00-\a48c\a4d0-\a4fd\a500-\a60c\a610-\a61f\a62a-\a62b\a640-\a66e\a67f-\a69d\a6a0-\a6e5\a717-\a71f\a722-\a788\a78b-\a7dc\a7f1-\a801\a803-\a805\a807-\a80a\a80c-\a822\a840-\a873\a882-\a8b3\a8f2-\a8f7\a8fb\a8fd-\a8fe\a90a-\a925\a930-\a946\a960-\a97c\a984-\a9b2\a9cf\a9e0-\a9e4\a9e6-\a9ef\a9fa-\a9fe\aa00-\aa28\aa40-\aa42\aa44-\aa4b\aa60-\aa76\aa7a\aa7e-\aaaf\aab1\aab5-\aab6\aab9-\aabd\aac0\aac2\aadb-\aadd\aae0-\aaea\aaf2-\aaf4\ab01-\ab06\ab09-\ab0e\ab11-\ab16\ab20-\ab26\ab28-\ab2e\ab30-\ab5a\ab5c-\ab69\ab70-\abe2\ac00-\d7a3\d7b0-\d7c6\d7cb-\d7fb\f900-\fa6d\fa70-\fad9\fb00-\fb06\fb13-\fb17\fb1d\fb1f-\fb28\fb2a-\fb36\fb38-\fb3c\fb3e\fb40-\fb41\fb43-\fb44\fb46-\fbb1\fbd3-\fd3d\fd50-\fd8f\fd92-\fdc7\fdf0-\fdfb\fe70-\fe74\fe76-\fefc\ff21-\ff3a\ff41-\ff5a\ff66-\ffbe\ffc2-\ffc7\ffca-\ffcf\ffd2-\ffd7\ffda-\ffdc\+010000-\+01000b\+01000d-\+010026\+010028-\+01003a\+01003c-\+01003d\+01003f-\+01004d\+010050-\+01005d\+010080-\+0100fa\+010280-\+01029c\+0102a0-\+0102d0\+010300-\+01031f\+01032d-\+010340\+010342-\+010349\+010350-\+010375\+010380-\+01039d\+0103a0-\+0103c3\+0103c8-\+0103cf\+010400-\+01049d\+0104b0-\+0104d3\+0104d8-\+0104fb\+010500-\+010527\+010530-\+010563\+010570-\+01057a\+01057c-\+01058a\+01058c-\+010592\+010594-\+010595\+010597-\+0105a1\+0105a3-\+0105b1\+0105b3-\+0105b9\+0105bb-\+0105bc\+0105c0-\+0105f3\+010600-\+010736\+010740-\+010755\+010760-\+010767\+010780-\+010785\+010787-\+0107b0\+0107b2-\+0107ba\+010800-\+010805\+010808\+01080a-\+010835\+010837-\+010838\+01083c\+01083f-\+010855\+010860-\+010876\+010880-\+01089e\+0108e0-\+0108f2\+0108f4-\+0108f5\+010900-\+010915\+010920-\+010939\+010940-\+010959\+010980-\+0109b7\+0109be-\+0109bf\+010a00\+010a10-\+010a13\+010a15-\+010a17\+010a19-\+010a35\+010a60-\+010a7c\+010a80-\+010a9c\+010ac0-\+010ac7\+010ac9-\+010ae4\+010b00-\+010b35\+010b40-\+010b55\+010b60-\+010b72\+010b80-\+010b91\+010c00-\+010c48\+010c80-\+010cb2\+010cc0-\+010cf2\+010d00-\+010d23\+010d4a-\+010d65\+010d6f-\+010d85\+010e80-\+010ea9\+010eb0-\+010eb1\+010ec2-\+010ec7\+010f00-\+010f1c\+010f27\+010f30-\+010f45\+010f70-\+010f81\+010fb0-\+010fc4\+010fe0-\+010ff6\+011003-\+011037\+011071-\+011072\+011075\+011083-\+0110af\+0110d0-\+0110e8\+011103-\+011126\+011144\+011147\+011150-\+011172\+011176\+011183-\+0111b2\+0111c1-\+0111c4\+0111da\+0111dc\+011200-\+011211\+011213-\+01122b\+01123f-\+011240\+011280-\+011286\+011288\+01128a-\+01128d\+01128f-\+01129d\+01129f-\+0112a8\+0112b0-\+0112de\+011305-\+01130c\+01130f-\+011310\+011313-\+011328\+01132a-\+011330\+011332-\+011333\+011335-\+011339\+01133d\+011350\+01135d-\+011361\+011380-\+011389\+01138b\+01138e\+011390-\+0113b5\+0113b7\+0113d1\+0113d3\+011400-\+011434\+011447-\+01144a\+01145f-\+011461\+011480-\+0114af\+0114c4-\+0114c5\+0114c7\+011580-\+0115ae\+0115d8-\+0115db\+011600-\+01162f\+011644\+011680-\+0116aa\+0116b8\+011700-\+01171a\+011740-\+011746\+011800-\+01182b\+0118a0-\+0118df\+0118ff-\+011906\+011909\+01190c-\+011913\+011915-\+011916\+011918-\+01192f\+01193f\+011941\+0119a0-\+0119a7\+0119aa-\+0119d0\+0119e1\+0119e3\+011a00\+011a0b-\+011a32\+011a3a\+011a50\+011a5c-\+011a89\+011a9d\+011ab0-\+011af8\+011bc0-\+011be0\+011c00-\+011c08\+011c0a-\+011c2e\+011c40\+011c72-\+011c8f\+011d00-\+011d06\+011d08-\+011d09\+011d0b-\+011d30\+011d46\+011d60-\+011d65\+011d67-\+011d68\+011d6a-\+011d89\+011d98\+011db0-\+011ddb\+011ee0-\+011ef2\+011f02\+011f04-\+011f10\+011f12-\+011f33\+011fb0\+012000-\+012399\+012480-\+012543\+012f90-\+012ff0\+013000-\+01342f\+013441-\+013446\+013460-\+0143fa\+014400-\+014646\+016100-\+01611d\+016800-\+016a38\+016a40-\+016a5e\+016a70-\+016abe\+016ad0-\+016aed\+016b00-\+016b2f\+016b40-\+016b43\+016b63-\+016b77\+016b7d-\+016b8f\+016d40-\+016d6c\+016e40-\+016e7f\+016ea0-\+016eb8\+016ebb-\+016ed3\+016f00-\+016f4a\+016f50\+016f93-\+016f9f\+016fe0-\+016fe1\+016fe3\+016ff2-\+016ff3\+017000-\+018cd5\+018cff-\+018d1e\+018d80-\+018df2\+01aff0-\+01aff3\+01aff5-\+01affb\+01affd-\+01affe\+01b000-\+01b122\+01b132\+01b150-\+01b152\+01b155\+01b164-\+01b167\+01b170-\+01b2fb\+01bc00-\+01bc6a\+01bc70-\+01bc7c\+01bc80-\+01bc88\+01bc90-\+01bc99\+01d400-\+01d454\+01d456-\+01d49c\+01d49e-\+01d49f\+01d4a2\+01d4a5-\+01d4a6\+01d4a9-\+01d4ac\+01d4ae-\+01d4b9\+01d4bb\+01d4bd-\+01d4c3\+01d4c5-\+01d505\+01d507-\+01d50a\+01d50d-\+01d514\+01d516-\+01d51c\+01d51e-\+01d539\+01d53b-\+01d53e\+01d540-\+01d544\+01d546\+01d54a-\+01d550\+01d552-\+01d6a5\+01d6a8-\+01d6c0\+01d6c2-\+01d6da\+01d6dc-\+01d6fa\+01d6fc-\+01d714\+01d716-\+01d734\+01d736-\+01d74e\+01d750-\+01d76e\+01d770-\+01d788\+01d78a-\+01d7a8\+01d7aa-\+01d7c2\+01d7c4-\+01d7cb\+01df00-\+01df1e\+01df25-\+01df2a\+01e030-\+01e06d\+01e100-\+01e12c\+01e137-\+01e13d\+01e14e\+01e290-\+01e2ad\+01e2c0-\+01e2eb\+01e4d0-\+01e4eb\+01e5d0-\+01e5ed\+01e5f0\+01e6c0-\+01e6de\+01e6e0-\+01e6e2\+01e6e4-\+01e6e5\+01e6e7-\+01e6ed\+01e6f0-\+01e6f4\+01e6fe-\+01e6ff\+01e7e0-\+01e7e6\+01e7e8-\+01e7eb\+01e7ed-\+01e7ee\+01e7f0-\+01e7fe\+01e800-\+01e8c4\+01e900-\+01e943\+01e94b\+01ee00-\+01ee03\+01ee05-\+01ee1f\+01ee21-\+01ee22\+01ee24\+01ee27\+01ee29-\+01ee32\+01ee34-\+01ee37\+01ee39\+01ee3b\+01ee42\+01ee47\+01ee49\+01ee4b\+01ee4d-\+01ee4f\+01ee51-\+01ee52\+01ee54\+01ee57\+01ee59\+01ee5b\+01ee5d\+01ee5f\+01ee61-\+01ee62\+01ee64\+01ee67-\+01ee6a\+01ee6c-\+01ee72\+01ee74-\+01ee77\+01ee79-\+01ee7c\+01ee7e\+01ee80-\+01ee89\+01ee8b-\+01ee9b\+01eea1-\+01eea3\+01eea5-\+01eea9\+01eeab-\+01eebb\+020000-\+02a6df\+02a700-\+02b81d\+02b820-\+02cead\+02ceb0-\+02ebe0\+02ebf0-\+02ee5d\+02f800-\+02fa1d\+030000-\+03134a\+031350-\+033479]' and term !~ U&'[^\0021-\0023\0025-\002a\002c-\003b\003f-\\\005d\005f\0061-\007b\007d\00a1\00a7\00aa-\00ab\00b2-\00b3\00b5-\00b7\00b9-\00d6\00d8-\00f6\00f8-\02c1\02c6-\02d1\02e0-\02e4\02ec\02ee\0300-\0374\0376-\0377\037a-\037f\0386-\038a\038c\038e-\03a1\03a3-\03f5\03f7-\0481\0483-\052f\0531-\0556\0559-\058a\0591-\05c7\05d0-\05ea\05ef-\05f4\0609-\060a\060c-\060d\0610-\061b\061d-\06dc\06df-\06e8\06ea-\06fc\06ff-\070d\0710-\074a\074d-\07b1\07c0-\07f5\07f7-\07fa\07fd\0800-\082d\0830-\083e\0840-\085b\085e\0860-\086a\0870-\0887\0889-\088f\0897-\08e1\08e3-\0983\0985-\098c\098f-\0990\0993-\09a8\09aa-\09b0\09b2\09b6-\09b9\09bc-\09c4\09c7-\09c8\09cb-\09ce\09d7\09dc-\09dd\09df-\09e3\09e6-\09f1\09f4-\09f9\09fc-\09fe\0a01-\0a03\0a05-\0a0a\0a0f-\0a10\0a13-\0a28\0a2a-\0a30\0a32-\0a33\0a35-\0a36\0a38-\0a39\0a3c\0a3e-\0a42\0a47-\0a48\0a4b-\0a4d\0a51\0a59-\0a5c\0a5e\0a66-\0a76\0a81-\0a83\0a85-\0a8d\0a8f-\0a91\0a93-\0aa8\0aaa-\0ab0\0ab2-\0ab3\0ab5-\0ab9\0abc-\0ac5\0ac7-\0ac9\0acb-\0acd\0ad0\0ae0-\0ae3\0ae6-\0af0\0af9-\0aff\0b01-\0b03\0b05-\0b0c\0b0f-\0b10\0b13-\0b28\0b2a-\0b30\0b32-\0b33\0b35-\0b39\0b3c-\0b44\0b47-\0b48\0b4b-\0b4d\0b55-\0b57\0b5c-\0b5d\0b5f-\0b63\0b66-\0b6f\0b71-\0b77\0b82-\0b83\0b85-\0b8a\0b8e-\0b90\0b92-\0b95\0b99-\0b9a\0b9c\0b9e-\0b9f\0ba3-\0ba4\0ba8-\0baa\0bae-\0bb9\0bbe-\0bc2\0bc6-\0bc8\0bca-\0bcd\0bd0\0bd7\0be6-\0bf2\0c00-\0c0c\0c0e-\0c10\0c12-\0c28\0c2a-\0c39\0c3c-\0c44\0c46-\0c48\0c4a-\0c4d\0c55-\0c56\0c58-\0c5a\0c5c-\0c5d\0c60-\0c63\0c66-\0c6f\0c77-\0c7e\0c80-\0c8c\0c8e-\0c90\0c92-\0ca8\0caa-\0cb3\0cb5-\0cb9\0cbc-\0cc4\0cc6-\0cc8\0cca-\0ccd\0cd5-\0cd6\0cdc-\0cde\0ce0-\0ce3\0ce6-\0cef\0cf1-\0cf3\0d00-\0d0c\0d0e-\0d10\0d12-\0d44\0d46-\0d48\0d4a-\0d4e\0d54-\0d63\0d66-\0d78\0d7a-\0d7f\0d81-\0d83\0d85-\0d96\0d9a-\0db1\0db3-\0dbb\0dbd\0dc0-\0dc6\0dca\0dcf-\0dd4\0dd6\0dd8-\0ddf\0de6-\0def\0df2-\0df4\0e01-\0e3a\0e40-\0e5b\0e81-\0e82\0e84\0e86-\0e8a\0e8c-\0ea3\0ea5\0ea7-\0ebd\0ec0-\0ec4\0ec6\0ec8-\0ece\0ed0-\0ed9\0edc-\0edf\0f00\0f04-\0f12\0f14\0f18-\0f19\0f20-\0f33\0f35\0f37\0f39-\0f47\0f49-\0f6c\0f71-\0f97\0f99-\0fbc\0fc6\0fd0-\0fd4\0fd9-\0fda\1000-\109d\10a0-\10c5\10c7\10cd\10d0-\1248\124a-\124d\1250-\1256\1258\125a-\125d\1260-\1288\128a-\128d\1290-\12b0\12b2-\12b5\12b8-\12be\12c0\12c2-\12c5\12c8-\12d6\12d8-\1310\1312-\1315\1318-\135a\135d-\137c\1380-\138f\13a0-\13f5\13f8-\13fd\1400-\166c\166e-\167f\1681-\169c\16a0-\16f8\1700-\1715\171f-\1736\1740-\1753\1760-\176c\176e-\1770\1772-\1773\1780-\17da\17dc-\17dd\17e0-\17e9\17f0-\17f9\1800-\180d\180f-\1819\1820-\1878\1880-\18aa\18b0-\18f5\1900-\191e\1920-\192b\1930-\193b\1944-\196d\1970-\1974\1980-\19ab\19b0-\19c9\19d0-\19da\1a00-\1a1b\1a1e-\1a5e\1a60-\1a7c\1a7f-\1a89\1a90-\1a99\1aa0-\1aad\1ab0-\1add\1ae0-\1aeb\1b00-\1b4c\1b4e-\1b60\1b6b-\1b73\1b7d-\1bf3\1bfc-\1c37\1c3b-\1c49\1c4d-\1c8a\1c90-\1cba\1cbd-\1cc7\1cd0-\1cfa\1d00-\1f15\1f18-\1f1d\1f20-\1f45\1f48-\1f4d\1f50-\1f57\1f59\1f5b\1f5d\1f5f-\1f7d\1f80-\1fb4\1fb6-\1fbc\1fbe\1fc2-\1fc4\1fc6-\1fcc\1fd0-\1fd3\1fd6-\1fdb\1fe0-\1fec\1ff2-\1ff4\1ff6-\1ffc\2010-\2027\2030-\2043\2045-\2051\2053-\205e\2070-\2071\2074-\2079\207d-\2089\208d-\208e\2090-\209c\20d0-\20f0\2102\2107\210a-\2113\2115\2119-\211d\2124\2126\2128\212a-\212d\212f-\2139\213c-\213f\2145-\2149\214e\2150-\2189\2308-\230b\2329-\232a\2460-\249b\24ea-\24ff\2768-\2793\27c5-\27c6\27e6-\27ef\2983-\2998\29d8-\29db\29fc-\29fd\2c00-\2ce4\2ceb-\2cf3\2cf9-\2d25\2d27\2d2d\2d30-\2d67\2d6f-\2d70\2d7f-\2d96\2da0-\2da6\2da8-\2dae\2db0-\2db6\2db8-\2dbe\2dc0-\2dc6\2dc8-\2dce\2dd0-\2dd6\2dd8-\2dde\2de0-\2e4f\2e52-\2e5d\3001-\3003\3005-\3011\3014-\301f\3021-\3035\3038-\303d\3041-\3096\3099-\309a\309d-\30ff\3105-\312f\3131-\318e\3192-\3195\31a0-\31bf\31f0-\31ff\3220-\3229\3248-\324f\3251-\325f\3280-\3289\32b1-\32bf\3400-\4dbf\4e00-\a48c\a4d0-\a62b\a640-\a6f7\a717-\a71f\a722-\a788\a78b-\a7dc\a7f1-\a827\a82c\a830-\a835\a840-\a877\a880-\a8c5\a8ce-\a8d9\a8e0-\a953\a95f-\a97c\a980-\a9cd\a9cf-\a9d9\a9de-\a9fe\aa00-\aa36\aa40-\aa4d\aa50-\aa59\aa5c-\aa76\aa7a-\aac2\aadb-\aaf6\ab01-\ab06\ab09-\ab0e\ab11-\ab16\ab20-\ab26\ab28-\ab2e\ab30-\ab5a\ab5c-\ab69\ab70-\abed\abf0-\abf9\ac00-\d7a3\d7b0-\d7c6\d7cb-\d7fb\f900-\fa6d\fa70-\fad9\fb00-\fb06\fb13-\fb17\fb1d-\fb28\fb2a-\fb36\fb38-\fb3c\fb3e\fb40-\fb41\fb43-\fb44\fb46-\fbb1\fbd3-\fd3f\fd50-\fd8f\fd92-\fdc7\fdf0-\fdfb\fe00-\fe19\fe20-\fe52\fe54-\fe61\fe63\fe68\fe6a-\fe6b\fe70-\fe74\fe76-\fefc\ff01-\ff03\ff05-\ff0a\ff0c-\ff1b\ff1f-\ff3d\ff3f\ff41-\ff5b\ff5d\ff5f-\ffbe\ffc2-\ffc7\ffca-\ffcf\ffd2-\ffd7\ffda-\ffdc\+010000-\+01000b\+01000d-\+010026\+010028-\+01003a\+01003c-\+01003d\+01003f-\+01004d\+010050-\+01005d\+010080-\+0100fa\+010100-\+010102\+010107-\+010133\+010140-\+010178\+01018a-\+01018b\+0101fd\+010280-\+01029c\+0102a0-\+0102d0\+0102e0-\+0102fb\+010300-\+010323\+01032d-\+01034a\+010350-\+01037a\+010380-\+01039d\+01039f-\+0103c3\+0103c8-\+0103d5\+010400-\+01049d\+0104a0-\+0104a9\+0104b0-\+0104d3\+0104d8-\+0104fb\+010500-\+010527\+010530-\+010563\+01056f-\+01057a\+01057c-\+01058a\+01058c-\+010592\+010594-\+010595\+010597-\+0105a1\+0105a3-\+0105b1\+0105b3-\+0105b9\+0105bb-\+0105bc\+0105c0-\+0105f3\+010600-\+010736\+010740-\+010755\+010760-\+010767\+010780-\+010785\+010787-\+0107b0\+0107b2-\+0107ba\+010800-\+010805\+010808\+01080a-\+010835\+010837-\+010838\+01083c\+01083f-\+010855\+010857-\+010876\+010879-\+01089e\+0108a7-\+0108af\+0108e0-\+0108f2\+0108f4-\+0108f5\+0108fb-\+01091b\+01091f-\+010939\+01093f-\+010959\+010980-\+0109b7\+0109bc-\+0109cf\+0109d2-\+010a03\+010a05-\+010a06\+010a0c-\+010a13\+010a15-\+010a17\+010a19-\+010a35\+010a38-\+010a3a\+010a3f-\+010a48\+010a50-\+010a58\+010a60-\+010a9f\+010ac0-\+010ac7\+010ac9-\+010ae6\+010aeb-\+010af6\+010b00-\+010b35\+010b39-\+010b55\+010b58-\+010b72\+010b78-\+010b91\+010b99-\+010b9c\+010ba9-\+010baf\+010c00-\+010c48\+010c80-\+010cb2\+010cc0-\+010cf2\+010cfa-\+010d27\+010d30-\+010d39\+010d40-\+010d65\+010d69-\+010d85\+010e60-\+010e7e\+010e80-\+010ea9\+010eab-\+010ead\+010eb0-\+010eb1\+010ec2-\+010ec7\+010ed0\+010efa-\+010f27\+010f30-\+010f59\+010f70-\+010f89\+010fb0-\+010fcb\+010fe0-\+010ff6\+011000-\+01104d\+011052-\+011075\+01107f-\+0110bc\+0110be-\+0110c2\+0110d0-\+0110e8\+0110f0-\+0110f9\+011100-\+011134\+011136-\+011147\+011150-\+011176\+011180-\+0111df\+0111e1-\+0111f4\+011200-\+011211\+011213-\+011241\+011280-\+011286\+011288\+01128a-\+01128d\+01128f-\+01129d\+01129f-\+0112a9\+0112b0-\+0112ea\+0112f0-\+0112f9\+011300-\+011303\+011305-\+01130c\+01130f-\+011310\+011313-\+011328\+01132a-\+011330\+011332-\+011333\+011335-\+011339\+01133b-\+011344\+011347-\+011348\+01134b-\+01134d\+011350\+011357\+01135d-\+011363\+011366-\+01136c\+011370-\+011374\+011380-\+011389\+01138b\+01138e\+011390-\+0113b5\+0113b7-\+0113c0\+0113c2\+0113c5\+0113c7-\+0113ca\+0113cc-\+0113d5\+0113d7-\+0113d8\+0113e1-\+0113e2\+011400-\+01145b\+01145d-\+011461\+011480-\+0114c7\+0114d0-\+0114d9\+011580-\+0115b5\+0115b8-\+0115dd\+011600-\+011644\+011650-\+011659\+011660-\+01166c\+011680-\+0116b9\+0116c0-\+0116c9\+0116d0-\+0116e3\+011700-\+01171a\+01171d-\+01172b\+011730-\+01173e\+011740-\+011746\+011800-\+01183b\+0118a0-\+0118f2\+0118ff-\+011906\+011909\+01190c-\+011913\+011915-\+011916\+011918-\+011935\+011937-\+011938\+01193b-\+011946\+011950-\+011959\+0119a0-\+0119a7\+0119aa-\+0119d7\+0119da-\+0119e4\+011a00-\+011a47\+011a50-\+011aa2\+011ab0-\+011af8\+011b00-\+011b09\+011b60-\+011b67\+011bc0-\+011be1\+011bf0-\+011bf9\+011c00-\+011c08\+011c0a-\+011c36\+011c38-\+011c45\+011c50-\+011c6c\+011c70-\+011c8f\+011c92-\+011ca7\+011ca9-\+011cb6\+011d00-\+011d06\+011d08-\+011d09\+011d0b-\+011d36\+011d3a\+011d3c-\+011d3d\+011d3f-\+011d47\+011d50-\+011d59\+011d60-\+011d65\+011d67-\+011d68\+011d6a-\+011d8e\+011d90-\+011d91\+011d93-\+011d98\+011da0-\+011da9\+011db0-\+011ddb\+011de0-\+011de9\+011ee0-\+011ef8\+011f00-\+011f10\+011f12-\+011f3a\+011f3e-\+011f5a\+011fb0\+011fc0-\+011fd4\+011fff-\+012399\+012400-\+01246e\+012470-\+012474\+012480-\+012543\+012f90-\+012ff2\+013000-\+01342f\+013440-\+013455\+013460-\+0143fa\+014400-\+014646\+016100-\+016139\+016800-\+016a38\+016a40-\+016a5e\+016a60-\+016a69\+016a6e-\+016abe\+016ac0-\+016ac9\+016ad0-\+016aed\+016af0-\+016af5\+016b00-\+016b3b\+016b40-\+016b44\+016b50-\+016b59\+016b5b-\+016b61\+016b63-\+016b77\+016b7d-\+016b8f\+016d40-\+016d79\+016e40-\+016e9a\+016ea0-\+016eb8\+016ebb-\+016ed3\+016f00-\+016f4a\+016f4f-\+016f87\+016f8f-\+016f9f\+016fe0-\+016fe4\+016ff0-\+016ff6\+017000-\+018cd5\+018cff-\+018d1e\+018d80-\+018df2\+01aff0-\+01aff3\+01aff5-\+01affb\+01affd-\+01affe\+01b000-\+01b122\+01b132\+01b150-\+01b152\+01b155\+01b164-\+01b167\+01b170-\+01b2fb\+01bc00-\+01bc6a\+01bc70-\+01bc7c\+01bc80-\+01bc88\+01bc90-\+01bc99\+01bc9d-\+01bc9f\+01ccf0-\+01ccf9\+01cf00-\+01cf2d\+01cf30-\+01cf46\+01d165-\+01d169\+01d16d-\+01d172\+01d17b-\+01d182\+01d185-\+01d18b\+01d1aa-\+01d1ad\+01d242-\+01d244\+01d2c0-\+01d2d3\+01d2e0-\+01d2f3\+01d360-\+01d378\+01d400-\+01d454\+01d456-\+01d49c\+01d49e-\+01d49f\+01d4a2\+01d4a5-\+01d4a6\+01d4a9-\+01d4ac\+01d4ae-\+01d4b9\+01d4bb\+01d4bd-\+01d4c3\+01d4c5-\+01d505\+01d507-\+01d50a\+01d50d-\+01d514\+01d516-\+01d51c\+01d51e-\+01d539\+01d53b-\+01d53e\+01d540-\+01d544\+01d546\+01d54a-\+01d550\+01d552-\+01d6a5\+01d6a8-\+01d6c0\+01d6c2-\+01d6da\+01d6dc-\+01d6fa\+01d6fc-\+01d714\+01d716-\+01d734\+01d736-\+01d74e\+01d750-\+01d76e\+01d770-\+01d788\+01d78a-\+01d7a8\+01d7aa-\+01d7c2\+01d7c4-\+01d7cb\+01d7ce-\+01d7ff\+01da00-\+01da36\+01da3b-\+01da6c\+01da75\+01da84\+01da87-\+01da8b\+01da9b-\+01da9f\+01daa1-\+01daaf\+01df00-\+01df1e\+01df25-\+01df2a\+01e000-\+01e006\+01e008-\+01e018\+01e01b-\+01e021\+01e023-\+01e024\+01e026-\+01e02a\+01e030-\+01e06d\+01e08f\+01e100-\+01e12c\+01e130-\+01e13d\+01e140-\+01e149\+01e14e\+01e290-\+01e2ae\+01e2c0-\+01e2f9\+01e4d0-\+01e4f9\+01e5d0-\+01e5fa\+01e5ff\+01e6c0-\+01e6de\+01e6e0-\+01e6f5\+01e6fe-\+01e6ff\+01e7e0-\+01e7e6\+01e7e8-\+01e7eb\+01e7ed-\+01e7ee\+01e7f0-\+01e7fe\+01e800-\+01e8c4\+01e8c7-\+01e8d6\+01e900-\+01e94b\+01e950-\+01e959\+01e95e-\+01e95f\+01ec71-\+01ecab\+01ecad-\+01ecaf\+01ecb1-\+01ecb4\+01ed01-\+01ed2d\+01ed2f-\+01ed3d\+01ee00-\+01ee03\+01ee05-\+01ee1f\+01ee21-\+01ee22\+01ee24\+01ee27\+01ee29-\+01ee32\+01ee34-\+01ee37\+01ee39\+01ee3b\+01ee42\+01ee47\+01ee49\+01ee4b\+01ee4d-\+01ee4f\+01ee51-\+01ee52\+01ee54\+01ee57\+01ee59\+01ee5b\+01ee5d\+01ee5f\+01ee61-\+01ee62\+01ee64\+01ee67-\+01ee6a\+01ee6c-\+01ee72\+01ee74-\+01ee77\+01ee79-\+01ee7c\+01ee7e\+01ee80-\+01ee89\+01ee8b-\+01ee9b\+01eea1-\+01eea3\+01eea5-\+01eea9\+01eeab-\+01eebb\+01f100-\+01f10c\+01fbf0-\+01fbf9\+020000-\+02a6df\+02a700-\+02b81d\+02b820-\+02cead\+02ceb0-\+02ebe0\+02ebf0-\+02ee5d\+02f800-\+02fa1d\+030000-\+03134a\+031350-\+033479\+0e0100-\+0e01ef ]' then
      canonical:=regexp_replace(replace(term,'&','and'),U&'[^\0030-\0039\0041-\005a\0061-\007a\00aa\00b2-\00b3\00b5\00b9-\00ba\00bc-\00be\00c0-\00d6\00d8-\00f6\00f8-\02c1\02c6-\02d1\02e0-\02e4\02ec\02ee\0300-\0374\0376-\0377\037a-\037d\037f\0386\0388-\038a\038c\038e-\03a1\03a3-\03f5\03f7-\0481\0483-\052f\0531-\0556\0559\0560-\0588\0591-\05bd\05bf\05c1-\05c2\05c4-\05c5\05c7\05d0-\05ea\05ef-\05f2\0610-\061a\0620-\0669\066e-\06d3\06d5-\06dc\06df-\06e8\06ea-\06fc\06ff\0710-\074a\074d-\07b1\07c0-\07f5\07fa\07fd\0800-\082d\0840-\085b\0860-\086a\0870-\0887\0889-\088f\0897-\08e1\08e3-\0963\0966-\096f\0971-\0983\0985-\098c\098f-\0990\0993-\09a8\09aa-\09b0\09b2\09b6-\09b9\09bc-\09c4\09c7-\09c8\09cb-\09ce\09d7\09dc-\09dd\09df-\09e3\09e6-\09f1\09f4-\09f9\09fc\09fe\0a01-\0a03\0a05-\0a0a\0a0f-\0a10\0a13-\0a28\0a2a-\0a30\0a32-\0a33\0a35-\0a36\0a38-\0a39\0a3c\0a3e-\0a42\0a47-\0a48\0a4b-\0a4d\0a51\0a59-\0a5c\0a5e\0a66-\0a75\0a81-\0a83\0a85-\0a8d\0a8f-\0a91\0a93-\0aa8\0aaa-\0ab0\0ab2-\0ab3\0ab5-\0ab9\0abc-\0ac5\0ac7-\0ac9\0acb-\0acd\0ad0\0ae0-\0ae3\0ae6-\0aef\0af9-\0aff\0b01-\0b03\0b05-\0b0c\0b0f-\0b10\0b13-\0b28\0b2a-\0b30\0b32-\0b33\0b35-\0b39\0b3c-\0b44\0b47-\0b48\0b4b-\0b4d\0b55-\0b57\0b5c-\0b5d\0b5f-\0b63\0b66-\0b6f\0b71-\0b77\0b82-\0b83\0b85-\0b8a\0b8e-\0b90\0b92-\0b95\0b99-\0b9a\0b9c\0b9e-\0b9f\0ba3-\0ba4\0ba8-\0baa\0bae-\0bb9\0bbe-\0bc2\0bc6-\0bc8\0bca-\0bcd\0bd0\0bd7\0be6-\0bf2\0c00-\0c0c\0c0e-\0c10\0c12-\0c28\0c2a-\0c39\0c3c-\0c44\0c46-\0c48\0c4a-\0c4d\0c55-\0c56\0c58-\0c5a\0c5c-\0c5d\0c60-\0c63\0c66-\0c6f\0c78-\0c7e\0c80-\0c83\0c85-\0c8c\0c8e-\0c90\0c92-\0ca8\0caa-\0cb3\0cb5-\0cb9\0cbc-\0cc4\0cc6-\0cc8\0cca-\0ccd\0cd5-\0cd6\0cdc-\0cde\0ce0-\0ce3\0ce6-\0cef\0cf1-\0cf3\0d00-\0d0c\0d0e-\0d10\0d12-\0d44\0d46-\0d48\0d4a-\0d4e\0d54-\0d63\0d66-\0d78\0d7a-\0d7f\0d81-\0d83\0d85-\0d96\0d9a-\0db1\0db3-\0dbb\0dbd\0dc0-\0dc6\0dca\0dcf-\0dd4\0dd6\0dd8-\0ddf\0de6-\0def\0df2-\0df3\0e01-\0e3a\0e40-\0e4e\0e50-\0e59\0e81-\0e82\0e84\0e86-\0e8a\0e8c-\0ea3\0ea5\0ea7-\0ebd\0ec0-\0ec4\0ec6\0ec8-\0ece\0ed0-\0ed9\0edc-\0edf\0f00\0f18-\0f19\0f20-\0f33\0f35\0f37\0f39\0f3e-\0f47\0f49-\0f6c\0f71-\0f84\0f86-\0f97\0f99-\0fbc\0fc6\1000-\1049\1050-\109d\10a0-\10c5\10c7\10cd\10d0-\10fa\10fc-\1248\124a-\124d\1250-\1256\1258\125a-\125d\1260-\1288\128a-\128d\1290-\12b0\12b2-\12b5\12b8-\12be\12c0\12c2-\12c5\12c8-\12d6\12d8-\1310\1312-\1315\1318-\135a\135d-\135f\1369-\137c\1380-\138f\13a0-\13f5\13f8-\13fd\1401-\166c\166f-\167f\1681-\169a\16a0-\16ea\16ee-\16f8\1700-\1715\171f-\1734\1740-\1753\1760-\176c\176e-\1770\1772-\1773\1780-\17d3\17d7\17dc-\17dd\17e0-\17e9\17f0-\17f9\180b-\180d\180f-\1819\1820-\1878\1880-\18aa\18b0-\18f5\1900-\191e\1920-\192b\1930-\193b\1946-\196d\1970-\1974\1980-\19ab\19b0-\19c9\19d0-\19da\1a00-\1a1b\1a20-\1a5e\1a60-\1a7c\1a7f-\1a89\1a90-\1a99\1aa7\1ab0-\1add\1ae0-\1aeb\1b00-\1b4c\1b50-\1b59\1b6b-\1b73\1b80-\1bf3\1c00-\1c37\1c40-\1c49\1c4d-\1c7d\1c80-\1c8a\1c90-\1cba\1cbd-\1cbf\1cd0-\1cd2\1cd4-\1cfa\1d00-\1f15\1f18-\1f1d\1f20-\1f45\1f48-\1f4d\1f50-\1f57\1f59\1f5b\1f5d\1f5f-\1f7d\1f80-\1fb4\1fb6-\1fbc\1fbe\1fc2-\1fc4\1fc6-\1fcc\1fd0-\1fd3\1fd6-\1fdb\1fe0-\1fec\1ff2-\1ff4\1ff6-\1ffc\2070-\2071\2074-\2079\207f-\2089\2090-\209c\20d0-\20f0\2102\2107\210a-\2113\2115\2119-\211d\2124\2126\2128\212a-\212d\212f-\2139\213c-\213f\2145-\2149\214e\2150-\2189\2460-\249b\24ea-\24ff\2776-\2793\2c00-\2ce4\2ceb-\2cf3\2cfd\2d00-\2d25\2d27\2d2d\2d30-\2d67\2d6f\2d7f-\2d96\2da0-\2da6\2da8-\2dae\2db0-\2db6\2db8-\2dbe\2dc0-\2dc6\2dc8-\2dce\2dd0-\2dd6\2dd8-\2dde\2de0-\2dff\2e2f\3005-\3007\3021-\302f\3031-\3035\3038-\303c\3041-\3096\3099-\309a\309d-\309f\30a1-\30fa\30fc-\30ff\3105-\312f\3131-\318e\3192-\3195\31a0-\31bf\31f0-\31ff\3220-\3229\3248-\324f\3251-\325f\3280-\3289\32b1-\32bf\3400-\4dbf\4e00-\a48c\a4d0-\a4fd\a500-\a60c\a610-\a62b\a640-\a672\a674-\a67d\a67f-\a6f1\a717-\a71f\a722-\a788\a78b-\a7dc\a7f1-\a827\a82c\a830-\a835\a840-\a873\a880-\a8c5\a8d0-\a8d9\a8e0-\a8f7\a8fb\a8fd-\a92d\a930-\a953\a960-\a97c\a980-\a9c0\a9cf-\a9d9\a9e0-\a9fe\aa00-\aa36\aa40-\aa4d\aa50-\aa59\aa60-\aa76\aa7a-\aac2\aadb-\aadd\aae0-\aaef\aaf2-\aaf6\ab01-\ab06\ab09-\ab0e\ab11-\ab16\ab20-\ab26\ab28-\ab2e\ab30-\ab5a\ab5c-\ab69\ab70-\abea\abec-\abed\abf0-\abf9\ac00-\d7a3\d7b0-\d7c6\d7cb-\d7fb\f900-\fa6d\fa70-\fad9\fb00-\fb06\fb13-\fb17\fb1d-\fb28\fb2a-\fb36\fb38-\fb3c\fb3e\fb40-\fb41\fb43-\fb44\fb46-\fbb1\fbd3-\fd3d\fd50-\fd8f\fd92-\fdc7\fdf0-\fdfb\fe00-\fe0f\fe20-\fe2f\fe70-\fe74\fe76-\fefc\ff10-\ff19\ff21-\ff3a\ff41-\ff5a\ff66-\ffbe\ffc2-\ffc7\ffca-\ffcf\ffd2-\ffd7\ffda-\ffdc\+010000-\+01000b\+01000d-\+010026\+010028-\+01003a\+01003c-\+01003d\+01003f-\+01004d\+010050-\+01005d\+010080-\+0100fa\+010107-\+010133\+010140-\+010178\+01018a-\+01018b\+0101fd\+010280-\+01029c\+0102a0-\+0102d0\+0102e0-\+0102fb\+010300-\+010323\+01032d-\+01034a\+010350-\+01037a\+010380-\+01039d\+0103a0-\+0103c3\+0103c8-\+0103cf\+0103d1-\+0103d5\+010400-\+01049d\+0104a0-\+0104a9\+0104b0-\+0104d3\+0104d8-\+0104fb\+010500-\+010527\+010530-\+010563\+010570-\+01057a\+01057c-\+01058a\+01058c-\+010592\+010594-\+010595\+010597-\+0105a1\+0105a3-\+0105b1\+0105b3-\+0105b9\+0105bb-\+0105bc\+0105c0-\+0105f3\+010600-\+010736\+010740-\+010755\+010760-\+010767\+010780-\+010785\+010787-\+0107b0\+0107b2-\+0107ba\+010800-\+010805\+010808\+01080a-\+010835\+010837-\+010838\+01083c\+01083f-\+010855\+010858-\+010876\+010879-\+01089e\+0108a7-\+0108af\+0108e0-\+0108f2\+0108f4-\+0108f5\+0108fb-\+01091b\+010920-\+010939\+010940-\+010959\+010980-\+0109b7\+0109bc-\+0109cf\+0109d2-\+010a03\+010a05-\+010a06\+010a0c-\+010a13\+010a15-\+010a17\+010a19-\+010a35\+010a38-\+010a3a\+010a3f-\+010a48\+010a60-\+010a7e\+010a80-\+010a9f\+010ac0-\+010ac7\+010ac9-\+010ae6\+010aeb-\+010aef\+010b00-\+010b35\+010b40-\+010b55\+010b58-\+010b72\+010b78-\+010b91\+010ba9-\+010baf\+010c00-\+010c48\+010c80-\+010cb2\+010cc0-\+010cf2\+010cfa-\+010d27\+010d30-\+010d39\+010d40-\+010d65\+010d69-\+010d6d\+010d6f-\+010d85\+010e60-\+010e7e\+010e80-\+010ea9\+010eab-\+010eac\+010eb0-\+010eb1\+010ec2-\+010ec7\+010efa-\+010f27\+010f30-\+010f54\+010f70-\+010f85\+010fb0-\+010fcb\+010fe0-\+010ff6\+011000-\+011046\+011052-\+011075\+01107f-\+0110ba\+0110c2\+0110d0-\+0110e8\+0110f0-\+0110f9\+011100-\+011134\+011136-\+01113f\+011144-\+011147\+011150-\+011173\+011176\+011180-\+0111c4\+0111c9-\+0111cc\+0111ce-\+0111da\+0111dc\+0111e1-\+0111f4\+011200-\+011211\+011213-\+011237\+01123e-\+011241\+011280-\+011286\+011288\+01128a-\+01128d\+01128f-\+01129d\+01129f-\+0112a8\+0112b0-\+0112ea\+0112f0-\+0112f9\+011300-\+011303\+011305-\+01130c\+01130f-\+011310\+011313-\+011328\+01132a-\+011330\+011332-\+011333\+011335-\+011339\+01133b-\+011344\+011347-\+011348\+01134b-\+01134d\+011350\+011357\+01135d-\+011363\+011366-\+01136c\+011370-\+011374\+011380-\+011389\+01138b\+01138e\+011390-\+0113b5\+0113b7-\+0113c0\+0113c2\+0113c5\+0113c7-\+0113ca\+0113cc-\+0113d3\+0113e1-\+0113e2\+011400-\+01144a\+011450-\+011459\+01145e-\+011461\+011480-\+0114c5\+0114c7\+0114d0-\+0114d9\+011580-\+0115b5\+0115b8-\+0115c0\+0115d8-\+0115dd\+011600-\+011640\+011644\+011650-\+011659\+011680-\+0116b8\+0116c0-\+0116c9\+0116d0-\+0116e3\+011700-\+01171a\+01171d-\+01172b\+011730-\+01173b\+011740-\+011746\+011800-\+01183a\+0118a0-\+0118f2\+0118ff-\+011906\+011909\+01190c-\+011913\+011915-\+011916\+011918-\+011935\+011937-\+011938\+01193b-\+011943\+011950-\+011959\+0119a0-\+0119a7\+0119aa-\+0119d7\+0119da-\+0119e1\+0119e3-\+0119e4\+011a00-\+011a3e\+011a47\+011a50-\+011a99\+011a9d\+011ab0-\+011af8\+011b60-\+011b67\+011bc0-\+011be0\+011bf0-\+011bf9\+011c00-\+011c08\+011c0a-\+011c36\+011c38-\+011c40\+011c50-\+011c6c\+011c72-\+011c8f\+011c92-\+011ca7\+011ca9-\+011cb6\+011d00-\+011d06\+011d08-\+011d09\+011d0b-\+011d36\+011d3a\+011d3c-\+011d3d\+011d3f-\+011d47\+011d50-\+011d59\+011d60-\+011d65\+011d67-\+011d68\+011d6a-\+011d8e\+011d90-\+011d91\+011d93-\+011d98\+011da0-\+011da9\+011db0-\+011ddb\+011de0-\+011de9\+011ee0-\+011ef6\+011f00-\+011f10\+011f12-\+011f3a\+011f3e-\+011f42\+011f50-\+011f5a\+011fb0\+011fc0-\+011fd4\+012000-\+012399\+012400-\+01246e\+012480-\+012543\+012f90-\+012ff0\+013000-\+01342f\+013440-\+013455\+013460-\+0143fa\+014400-\+014646\+016100-\+016139\+016800-\+016a38\+016a40-\+016a5e\+016a60-\+016a69\+016a70-\+016abe\+016ac0-\+016ac9\+016ad0-\+016aed\+016af0-\+016af4\+016b00-\+016b36\+016b40-\+016b43\+016b50-\+016b59\+016b5b-\+016b61\+016b63-\+016b77\+016b7d-\+016b8f\+016d40-\+016d6c\+016d70-\+016d79\+016e40-\+016e96\+016ea0-\+016eb8\+016ebb-\+016ed3\+016f00-\+016f4a\+016f4f-\+016f87\+016f8f-\+016f9f\+016fe0-\+016fe1\+016fe3-\+016fe4\+016ff0-\+016ff6\+017000-\+018cd5\+018cff-\+018d1e\+018d80-\+018df2\+01aff0-\+01aff3\+01aff5-\+01affb\+01affd-\+01affe\+01b000-\+01b122\+01b132\+01b150-\+01b152\+01b155\+01b164-\+01b167\+01b170-\+01b2fb\+01bc00-\+01bc6a\+01bc70-\+01bc7c\+01bc80-\+01bc88\+01bc90-\+01bc99\+01bc9d-\+01bc9e\+01ccf0-\+01ccf9\+01cf00-\+01cf2d\+01cf30-\+01cf46\+01d165-\+01d169\+01d16d-\+01d172\+01d17b-\+01d182\+01d185-\+01d18b\+01d1aa-\+01d1ad\+01d242-\+01d244\+01d2c0-\+01d2d3\+01d2e0-\+01d2f3\+01d360-\+01d378\+01d400-\+01d454\+01d456-\+01d49c\+01d49e-\+01d49f\+01d4a2\+01d4a5-\+01d4a6\+01d4a9-\+01d4ac\+01d4ae-\+01d4b9\+01d4bb\+01d4bd-\+01d4c3\+01d4c5-\+01d505\+01d507-\+01d50a\+01d50d-\+01d514\+01d516-\+01d51c\+01d51e-\+01d539\+01d53b-\+01d53e\+01d540-\+01d544\+01d546\+01d54a-\+01d550\+01d552-\+01d6a5\+01d6a8-\+01d6c0\+01d6c2-\+01d6da\+01d6dc-\+01d6fa\+01d6fc-\+01d714\+01d716-\+01d734\+01d736-\+01d74e\+01d750-\+01d76e\+01d770-\+01d788\+01d78a-\+01d7a8\+01d7aa-\+01d7c2\+01d7c4-\+01d7cb\+01d7ce-\+01d7ff\+01da00-\+01da36\+01da3b-\+01da6c\+01da75\+01da84\+01da9b-\+01da9f\+01daa1-\+01daaf\+01df00-\+01df1e\+01df25-\+01df2a\+01e000-\+01e006\+01e008-\+01e018\+01e01b-\+01e021\+01e023-\+01e024\+01e026-\+01e02a\+01e030-\+01e06d\+01e08f\+01e100-\+01e12c\+01e130-\+01e13d\+01e140-\+01e149\+01e14e\+01e290-\+01e2ae\+01e2c0-\+01e2f9\+01e4d0-\+01e4f9\+01e5d0-\+01e5fa\+01e6c0-\+01e6de\+01e6e0-\+01e6f5\+01e6fe-\+01e6ff\+01e7e0-\+01e7e6\+01e7e8-\+01e7eb\+01e7ed-\+01e7ee\+01e7f0-\+01e7fe\+01e800-\+01e8c4\+01e8c7-\+01e8d6\+01e900-\+01e94b\+01e950-\+01e959\+01ec71-\+01ecab\+01ecad-\+01ecaf\+01ecb1-\+01ecb4\+01ed01-\+01ed2d\+01ed2f-\+01ed3d\+01ee00-\+01ee03\+01ee05-\+01ee1f\+01ee21-\+01ee22\+01ee24\+01ee27\+01ee29-\+01ee32\+01ee34-\+01ee37\+01ee39\+01ee3b\+01ee42\+01ee47\+01ee49\+01ee4b\+01ee4d-\+01ee4f\+01ee51-\+01ee52\+01ee54\+01ee57\+01ee59\+01ee5b\+01ee5d\+01ee5f\+01ee61-\+01ee62\+01ee64\+01ee67-\+01ee6a\+01ee6c-\+01ee72\+01ee74-\+01ee77\+01ee79-\+01ee7c\+01ee7e\+01ee80-\+01ee89\+01ee8b-\+01ee9b\+01eea1-\+01eea3\+01eea5-\+01eea9\+01eeab-\+01eebb\+01f100-\+01f10c\+01fbf0-\+01fbf9\+020000-\+02a6df\+02a700-\+02b81d\+02b820-\+02cead\+02ceb0-\+02ebe0\+02ebf0-\+02ee5d\+02f800-\+02fa1d\+030000-\+03134a\+031350-\+033479\+0e0100-\+0e01ef]','','g');return next 'identifier:'||canonical;
    end if;
  end if;
end $function$
;
CREATE OR REPLACE FUNCTION app.private_invoice_capture_field(p_workspace_id uuid, p_value text, p_kind text, p_revision bytea)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare memo_revision bytea:=sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8'));memo_write boolean:=pg_try_advisory_xact_lock(1128617036,1146310723);revision bytea:=p_revision; fingerprint bytea; monetary boolean:=false;aliases text[];base_keys text[];
begin
 if p_value is null or p_workspace_id is null then return;end if;
 fingerprint:=sha256(convert_to(p_value,'UTF8'));
 if exists(select 1 from app.private_invoice_canonical_inputs c where c.workspace_id=p_workspace_id and c.canonicalizer_revision=revision and c.input_kind=p_kind and c.input_hash=fingerprint) then return;end if;
 if p_kind not in ('generic','monetary','party','number','evidence') then raise exception 'INVALID_PRIVATE_INPUT_KIND';end if;
 -- Dispatch by the field's supplied role before building SQL alias plans.
 -- A scalar INSERT must not repeatedly initialize every generic/party/evidence
 -- projection in an otherwise disabled UNION branch.
 case p_kind
 when 'generic' then aliases:=app.private_dispatch_aliases(p_workspace_id,p_value,'generic',memo_revision,memo_write);
 when 'number' then aliases:=array(select * from app.private_invoice_numeric_candidates(p_value,false));
 when 'evidence' then aliases:=array(select * from app.private_invoice_evidence_aliases(p_value));
 when 'party' then
  aliases:=app.private_dispatch_aliases(p_workspace_id,p_value,'party',memo_revision,memo_write);
  if not ('party-ref:'||app.private_invoice_normalize(p_value))=any(aliases) then aliases:=aliases||app.private_dispatch_aliases(p_workspace_id,p_value,'generic',memo_revision,memo_write);end if;
 when 'monetary' then
  aliases:=array(select * from app.private_invoice_numeric_candidates(p_value,false));
  aliases:=aliases||array(select * from app.private_invoice_word_number_aliases(p_value));
  aliases:=aliases||array(select k from app.private_invoice_evidence_aliases(p_value) k where k ~ '^number(-run)?:');
  monetary:=cardinality(aliases)>0;
  if not monetary then aliases:=app.private_dispatch_aliases(p_workspace_id,p_value,'generic',memo_revision,memo_write);
  elsif p_value ~ '^[0-9]+$' or not exists(select 1 from app.private_invoice_term_aliases(p_value) k where k like 'date:%') then aliases:=array_append(aliases,app.private_invoice_normalize(p_value));end if;
 end case;
 insert into public.whatsapp_private_invoice_terms(workspace_id,term_hash,term)
 select distinct p_workspace_id,encode(sha256(convert_to(term,'UTF8')),'hex'),term from unnest(aliases) term
 where length(term) between 1 and 4000 and exists(select 1 from public.workspaces w where w.id=p_workspace_id) on conflict do nothing;
 -- Explicitly revisit origins even if their raw term predated this revision:
 -- ON CONFLICT alone would not fire the term-insert provenance trigger again.
 if p_kind in ('generic','monetary') then perform app.retain_private_origin_terms(p_workspace_id,p_value);end if;
 insert into app.private_invoice_canonical_inputs values(p_workspace_id,revision,p_kind,fingerprint) on conflict do nothing;
end $function$
;
CREATE OR REPLACE FUNCTION app.retain_private_origin_terms(p_workspace_id uuid, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare memo_revision bytea:=sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8'));memo_write boolean:=pg_try_advisory_xact_lock(1128617036,1146310723);document jsonb;documents jsonb[];revision bytea;fingerprint bytea;captured boolean:=false;fact text;
begin
 if p_text is null or p_workspace_id is null then return;end if;
 -- Pure numeric/structural text cannot contain a document event or a scoped
 -- identity. Numeric aliases are captured by the field-role projection itself.
 if not app.private_invoice_has_letters(p_text) then return;end if;
 -- Uniform lock order: terms -> generation/cache -> alias/marker writes.
 lock table public.whatsapp_private_invoice_terms in row exclusive mode;
 -- During ON DELETE CASCADE the workspace is already absent. Retention must
 -- not resurrect its private state or prevent the owner's atomic deletion.
 if not exists(select 1 from public.workspaces where id=p_workspace_id) then return;end if;
 -- Only actual origins need database completion state. Scope is checked
 -- first so parent deletion cannot be blocked by decoding a removed source.
 -- Completed entries are already a proof of full projection in this exact
 -- workspace/generation/revision. Check them before decoding the source again.
 revision:=app.private_invoice_capture_revision(p_workspace_id);
 fingerprint:=sha256(convert_to(p_text,'UTF8'));
 if exists(select 1 from app.private_invoice_canonical_inputs c where c.workspace_id=p_workspace_id and c.canonicalizer_revision=revision and c.input_kind='origin' and c.input_hash=fingerprint) then return;end if;
 documents:=array(select distinct * from app.private_invoice_origin_documents(to_jsonb(p_text),0));
 if cardinality(documents)=0 then
  for fact in select distinct * from app.private_invoice_scoped_fact_aliases(p_workspace_id,p_text) loop
   insert into public.whatsapp_private_invoice_terms(workspace_id,term_hash,term) values(p_workspace_id,encode(sha256(convert_to(fact,'UTF8')),'hex'),fact) on conflict do nothing;captured:=true;
  end loop;
  if not captured then return;end if;
 end if;
 foreach document in array documents loop
  captured:=true;
  if jsonb_typeof(document) in ('object','array') then
   perform app.retain_private_invoice_terms(p_workspace_id,document);
  else
   insert into public.whatsapp_private_invoice_terms(workspace_id,term_hash,term)
   select distinct p_workspace_id,encode(sha256(convert_to(term,'UTF8')),'hex'),term
   from unnest(app.private_dispatch_aliases(p_workspace_id,document #>> '{}','origin',memo_revision,memo_write)) term where length(term) between 1 and 4000
   and exists(select 1 from public.workspaces w where w.id=p_workspace_id) on conflict do nothing;
  end if;
 end loop;
 if captured then insert into app.private_invoice_canonical_inputs values(p_workspace_id,revision,'origin',fingerprint) on conflict do nothing;end if;
end $function$
;

-- Source membership and canonical projection are maintained on writes. A send
-- reads the deduplicated global set, never reparses or regroups every tenant.
create table if not exists app.private_dispatch_sources(
 workspace_id uuid not null references public.workspaces(id) deferrable initially deferred,
 term_hash text not null,term text not null,keys text[] not null,primary key(workspace_id,term_hash));
create index if not exists private_dispatch_sources_hash on app.private_dispatch_sources(term_hash);
create table if not exists app.private_dispatch_global_keys(
 workspace_id uuid not null,source_hash text not null,term_hash bytea not null,term text not null,alias_count integer not null default 0,primary key(workspace_id,source_hash,term_hash));
create table if not exists app.private_dispatch_raw_edges(
 workspace_id uuid not null,source_hash text not null,term_hash bytea not null,
 key_hash bytea not null,key text not null,primary key(workspace_id,source_hash,term_hash,key_hash),
 foreign key(workspace_id,source_hash,term_hash) references app.private_dispatch_global_keys(workspace_id,source_hash,term_hash) on delete cascade);
create index if not exists private_dispatch_global_order on app.private_dispatch_global_keys(term_hash);
create index if not exists private_dispatch_raw_edges_key on app.private_dispatch_raw_edges(key_hash);
create table if not exists app.private_dispatch_witnesses(
 workspace_id uuid not null,term_hash text not null,source_value text not null,party_hash bytea not null,party_key text not null,
 primary key(workspace_id,term_hash,party_hash));
create index if not exists private_dispatch_witnesses_party on app.private_dispatch_witnesses(party_hash);
create table if not exists app.private_dispatch_customer_parties(
 customer_id uuid not null references public.customers(id) on delete cascade,party_hash bytea not null,party_key text not null,
 primary key(customer_id,party_hash));
create index if not exists private_dispatch_customer_party on app.private_dispatch_customer_parties(party_hash);
create table if not exists app.private_dispatch_index_state(singleton boolean primary key default true check(singleton),revision text not null);
alter table app.private_dispatch_sources enable row level security;
alter table app.private_dispatch_global_keys enable row level security;
alter table app.private_dispatch_raw_edges enable row level security;
alter table app.private_dispatch_witnesses enable row level security;
alter table app.private_dispatch_customer_parties enable row level security;
alter table app.private_dispatch_index_state enable row level security;
revoke all on app.private_dispatch_sources,app.private_dispatch_global_keys,app.private_dispatch_raw_edges,app.private_dispatch_witnesses,app.private_dispatch_customer_parties,app.private_dispatch_index_state from public,anon,authenticated,service_role;

create or replace function app.private_dispatch_projection(p_workspace_id uuid,p_term text) returns text[]
language plpgsql volatile set search_path='' as $$
declare keys text[];
begin
 if p_term ~ '^[a-z-]+:' and p_term not like 'origin:%' then return array[p_term];end if;
 if app.private_invoice_decode_json(p_term) is not null then return array[p_term];end if;
 if p_term like 'origin:%' or p_term !~ '^[a-z-]+:' and app.private_invoice_has_origin(p_term) then
  keys:=array(select distinct k from unnest(app.private_dispatch_aliases(p_workspace_id,case when p_term like 'origin:%' then substring(p_term from 8) else p_term end,'origin',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),pg_try_advisory_xact_lock(1128617036,1146310723))) k
   where k ~ '^(number|number-run|date|date-range|party|party-native|party-latin|party-ref|identifier):');
  if cardinality(keys)>0 then return keys;end if;
 end if;
 return array[p_term];
end $$;

create or replace function app.fill_private_dispatch_edges() returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Called for new keys only; the global raw subset has its own partial index.
 insert into app.private_dispatch_raw_edges(workspace_id,source_hash,term_hash,key_hash,key)
 select g.workspace_id,g.source_hash,g.term_hash,sha256(convert_to(k,'UTF8')),k from app.private_dispatch_global_keys g
 cross join lateral (select distinct k from app.private_invoice_term_aliases(g.term)k where k<>g.term) a
 where g.term !~ '^[a-z-]+:' and g.alias_count=-1 on conflict do nothing;
 update app.private_dispatch_global_keys g set alias_count=(select count(*) from app.private_dispatch_raw_edges e where e.workspace_id=g.workspace_id and e.source_hash=g.source_hash and e.term_hash=g.term_hash)
 where g.alias_count=-1;
end $$;
create index if not exists private_dispatch_unprepared_raw on app.private_dispatch_global_keys(term_hash) where alias_count=-1;

create or replace function app.fill_private_dispatch_witnesses() returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into app.private_dispatch_witnesses(workspace_id,term_hash,source_value,party_hash,party_key)
 select s.workspace_id,s.term_hash,case when s.term like 'origin:%' then substring(s.term from 8) else s.term end,
 sha256(convert_to(k,'UTF8')),k
 from (select workspace_id,term_hash,term from app.private_dispatch_sources where term !~ '^[a-z-]+:' or term like 'origin:%')s
 cross join lateral (
  select k from unnest(app.private_dispatch_aliases(s.workspace_id,s.term,'party',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),pg_try_advisory_xact_lock(1128617036,1146310723)))k where s.term !~ '^[a-z-]+:'
  union select k from unnest(app.private_dispatch_aliases(s.workspace_id,case when s.term like 'origin:%' then substring(s.term from 8) else s.term end,'origin',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),pg_try_advisory_xact_lock(1128617036,1146310723)))k where k like 'party:%'
 )a on conflict do nothing;
end $$;
create index if not exists private_dispatch_sources_raw on app.private_dispatch_sources(term_hash) where term !~ '^[a-z-]+:' or term like 'origin:%';

create or replace function app.ensure_private_dispatch_index() returns boolean
language plpgsql security definer set search_path='' as $$
declare current_revision text:=app.private_invoice_canonical_revision();
begin
 if exists(select 1 from app.private_dispatch_index_state s where s.singleton and s.revision=current_revision) then return false;end if;
 perform pg_advisory_xact_lock(717717199);
 if exists(select 1 from app.private_dispatch_index_state s where s.singleton and s.revision=current_revision) then return false;end if;
 delete from app.private_dispatch_raw_edges;delete from app.private_dispatch_global_keys;delete from app.private_dispatch_sources;delete from app.private_dispatch_witnesses;
 insert into app.private_dispatch_sources select workspace_id,term_hash,term,app.private_dispatch_projection(workspace_id,term) from public.whatsapp_private_invoice_terms;
 insert into app.private_dispatch_global_keys(workspace_id,source_hash,term_hash,term,alias_count)
 select s.workspace_id,s.term_hash,sha256(convert_to(k,'UTF8')),k,case when k !~ '^[a-z-]+:' then -1 else 0 end
 from app.private_dispatch_sources s cross join lateral unnest(s.keys)k;
 perform app.fill_private_dispatch_edges();perform app.fill_private_dispatch_witnesses();
 delete from app.private_dispatch_customer_parties;
 insert into app.private_dispatch_customer_parties select distinct c.id,sha256(convert_to(k,'UTF8')),k from public.customers c cross join lateral app.private_invoice_party_aliases(app.private_invoice_normalize(c.name))k;
 insert into app.private_dispatch_index_state values(true,current_revision) on conflict(singleton) do update set revision=excluded.revision;
 return true;
end $$;

create or replace function app.maintain_private_dispatch_index() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if app.ensure_private_dispatch_index() then return null;end if;
 if tg_op in ('DELETE','UPDATE') then
  delete from app.private_dispatch_raw_edges g using dispatch_old_terms o where g.workspace_id=o.workspace_id and g.source_hash=o.term_hash;
  delete from app.private_dispatch_global_keys g using dispatch_old_terms o where g.workspace_id=o.workspace_id and g.source_hash=o.term_hash;
  delete from app.private_dispatch_sources g using dispatch_old_terms o where g.workspace_id=o.workspace_id and g.term_hash=o.term_hash;
  delete from app.private_dispatch_witnesses g using dispatch_old_terms o where g.workspace_id=o.workspace_id and g.term_hash=o.term_hash;
 end if;
 if tg_op in ('INSERT','UPDATE') then
  with added as (insert into app.private_dispatch_sources select workspace_id,term_hash,term,app.private_dispatch_projection(workspace_id,term) from dispatch_new_terms
    on conflict do nothing returning workspace_id,term_hash,keys)
  insert into app.private_dispatch_global_keys(workspace_id,source_hash,term_hash,term,alias_count)
  select r.workspace_id,r.term_hash,sha256(convert_to(k,'UTF8')),k,case when k !~ '^[a-z-]+:' then -1 else 0 end from added r cross join lateral unnest(r.keys)k;
  perform app.fill_private_dispatch_edges();
  -- Witnesses are needed only for new raw sources, not all retained rows.
  insert into app.private_dispatch_witnesses
  select distinct n.workspace_id,n.term_hash,case when n.term like 'origin:%' then substring(n.term from 8) else n.term end,sha256(convert_to(k,'UTF8')),k
  from dispatch_new_terms n cross join lateral (
   select k from unnest(app.private_dispatch_aliases(n.workspace_id,n.term,'party',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),pg_try_advisory_xact_lock(1128617036,1146310723)))k where n.term !~ '^[a-z-]+:'
   union select k from unnest(app.private_dispatch_aliases(n.workspace_id,case when n.term like 'origin:%' then substring(n.term from 8) else n.term end,'origin',sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8')),pg_try_advisory_xact_lock(1128617036,1146310723)))k where k like 'party:%'
  )a where n.term !~ '^[a-z-]+:' or n.term like 'origin:%' on conflict do nothing;
 end if;
 return null;
end $$;
create or replace function app.truncate_private_dispatch_index() returns trigger language plpgsql security definer set search_path='' as $$begin
 truncate app.private_dispatch_sources,app.private_dispatch_global_keys,app.private_dispatch_raw_edges,app.private_dispatch_witnesses;return null;end $$;
create or replace function app.maintain_private_dispatch_customer() returns trigger language plpgsql security definer set search_path='' as $$begin
 delete from app.private_dispatch_customer_parties where customer_id=new.id;
 insert into app.private_dispatch_customer_parties select new.id,sha256(convert_to(k,'UTF8')),k from app.private_invoice_party_aliases(app.private_invoice_normalize(new.name))k on conflict do nothing;return new;end $$;
drop trigger if exists private_dispatch_insert on public.whatsapp_private_invoice_terms;
create trigger private_dispatch_insert after insert on public.whatsapp_private_invoice_terms referencing new table as dispatch_new_terms for each statement execute function app.maintain_private_dispatch_index();
drop trigger if exists private_dispatch_delete on public.whatsapp_private_invoice_terms;
create trigger private_dispatch_delete after delete on public.whatsapp_private_invoice_terms referencing old table as dispatch_old_terms for each statement execute function app.maintain_private_dispatch_index();
drop trigger if exists private_dispatch_update on public.whatsapp_private_invoice_terms;
create trigger private_dispatch_update after update on public.whatsapp_private_invoice_terms referencing old table as dispatch_old_terms new table as dispatch_new_terms for each statement execute function app.maintain_private_dispatch_index();
drop trigger if exists private_dispatch_truncate on public.whatsapp_private_invoice_terms;
create trigger private_dispatch_truncate after truncate on public.whatsapp_private_invoice_terms for each statement execute function app.truncate_private_dispatch_index();
drop trigger if exists private_dispatch_customer on public.customers;
create trigger private_dispatch_customer after insert or update of name on public.customers for each row execute function app.maintain_private_dispatch_customer();
revoke all on function app.private_dispatch_projection(uuid,text),app.fill_private_dispatch_edges(),app.fill_private_dispatch_witnesses(),app.ensure_private_dispatch_index(),app.maintain_private_dispatch_index(),app.truncate_private_dispatch_index(),app.maintain_private_dispatch_customer() from public,anon,authenticated,service_role;
select app.ensure_private_dispatch_index();

create or replace function public.whatsapp_dispatch_privacy_snapshot(p_workspace_id uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare recipient uuid;allowed text[];terms text[];identities text[];owner_scope boolean:=false;revision bytea;memo_write boolean;
begin
 -- EXECUTE is restricted to service_role below; authenticated/anon cannot enter.
 if not coalesce((select count(*)=4 and bool_and(complete) from public.whatsapp_private_invoice_backfill),false) then
   raise exception 'Recipient privacy snapshot is not ready' using errcode='55000';
 end if;
 perform app.ensure_private_dispatch_index();
 revision:=sha256(convert_to(app.private_invoice_canonical_revision(),'UTF8'));
 memo_write:=pg_try_advisory_xact_lock(1128617036,1146310723);
 if p_workspace_id is not null then
   -- Same consent-independent owner proof used by resolveOwnerIdentity:
   -- current owner membership, current configured phone, actual code verification.
   select exists(select 1 from public.workspaces w
     join public.workspace_settings s on s.workspace_id=w.id and s.whatsapp_owner_phone=p_phone
     join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner'
     join public.whatsapp_owner_verifications v on v.workspace_id=w.id and v.requested_by=w.owner_id and v.phone=p_phone and v.verified_at is not null
     where w.id=p_workspace_id) into owner_scope;
   if not owner_scope then
     -- A removed binding owns no customer fields. Fixed consent confirmations
     -- still pass through the boundary and their existing inbound authority;
     -- multiple bindings remain an error rather than an ownership grant.
     recipient := (select id from public.customers where workspace_id=p_workspace_id and phone=p_phone);
   end if;
 end if;
 with documents as (
 select to_jsonb(c) doc from public.customers c where c.workspace_id=p_workspace_id and c.id=recipient
 union all select jsonb_build_object('business_name',s.business_name) from public.workspace_settings s where s.workspace_id=p_workspace_id
 union all select jsonb_build_object('remaining',greatest(0,i.total_amount-coalesce(i.amount_paid,0))) from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union all select to_jsonb(f) from public.invoice_files f join public.invoices i on i.id=f.invoice_id and i.workspace_id=f.workspace_id where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union all select (to_jsonb(i)-'metadata'-'notes')||jsonb_build_object('invoice_direction',i.metadata->'invoice_direction','printed_invoice_number',i.metadata->'printed_invoice_number','source_invoice_number',i.metadata->'source_invoice_number') from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=recipient
 ), leaves as materialized (select distinct v#>>'{}' value from documents,jsonb_path_query(doc,'strict $.** ? (@.type() == "string" || @.type() == "number")')v), approval_words as (
 select app.private_invoice_normalize(x.value) value from public.invoices i
 cross join lateral (values(i.metadata->>'approved_reminder_text'),(i.metadata#>>'{approved_reminder_delivery,body}')) x(value)
 where i.workspace_id=p_workspace_id and i.customer_id=recipient and x.value is not null
 ), review_parties as (
 select distinct k from approval_words cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,value,'origin',revision,memo_write)) k where k like 'party:%'
 ), independent_parties as (
 select p.party_key k from review_parties r
 join app.private_dispatch_customer_parties p on p.party_hash=sha256(convert_to(r.k,'UTF8')) and p.party_key=r.k
 union select w.party_key from review_parties r
 join app.private_dispatch_witnesses w on w.party_hash=sha256(convert_to(r.k,'UTF8')) and w.party_key=r.k
 where not exists(select 1 from approval_words a where a.value=w.source_value)
 ), keys as (
 select k from leaves cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,app.private_invoice_normalize(value),'generic',revision,memo_write)) k
 union select k from public.customers c cross join lateral unnest(app.private_dispatch_aliases(c.workspace_id,app.private_invoice_normalize(c.name),'party',revision,memo_write)) k where c.workspace_id=p_workspace_id and c.id=recipient
 union select k from public.invoices i cross join lateral unnest(app.private_dispatch_aliases(i.workspace_id,app.private_invoice_normalize(i.metadata->>'client_name'),'party',revision,memo_write)) k where i.workspace_id=p_workspace_id and i.customer_id=recipient
 union select k from public.workspace_settings s cross join lateral unnest(app.private_dispatch_aliases(s.workspace_id,app.private_invoice_normalize(s.business_name),'party',revision,memo_write)) k where s.workspace_id=p_workspace_id
 -- An owned review's complete prose is not itself a foreign field. This
 -- certifies only whole-field equality, never its numbers, dates or parties:
 -- foreign values embedded in reviewed words remain in the forbidden index.
 union select value from approval_words
 union select k from approval_words cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,value,'generic',revision,memo_write)) k where k like 'identifier:%'
 union select k from review_parties where not exists(select 1 from independent_parties p where p.k=review_parties.k)
 -- Existing verified-owner authority is workspace-wide (invoice-store.mjs).
 -- These remain ordinary allowed keys, not a dispatch or scanner exemption.
 union select t.term from public.whatsapp_private_invoice_terms t
 where t.workspace_id=p_workspace_id and owner_scope
 ) select array_agg(distinct k) into allowed from keys;
 -- Include foreign workspaces too: even owners may disclose only their scope.
 -- Whole-field aliases may have different renderings (125.00 versus 125).
 -- A raw field is owned only when it has an owned canonical key and EVERY
 -- canonical key agrees. Unknown keys or a foreign member keep it protected.
 -- Only actual origins need origin projection. Typed canonical terms used to
 -- execute the entire parser before their result was discarded by CASE.
 with owned as materialized (select distinct k,sha256(convert_to(k,'UTF8')) hash from unnest(coalesce(allowed,array[]::text[]))k),
 owned_raw as materialized (
  select e.workspace_id,e.source_hash,e.term_hash,g.term from owned o join app.private_dispatch_raw_edges e on e.key_hash=o.hash and e.key=o.k
  join app.private_dispatch_global_keys g on g.workspace_id=e.workspace_id and g.source_hash=e.source_hash and g.term_hash=e.term_hash
  group by e.workspace_id,e.source_hash,e.term_hash,g.term,g.alias_count having count(*)=g.alias_count
 ) select array_agg(g.term) into terms from (select distinct on(term_hash,term) term_hash,term from app.private_dispatch_global_keys order by term_hash,term) g
 where not exists(select 1 from owned o where o.hash=g.term_hash and o.k=g.term)
 and not exists(select 1 from owned_raw r where r.term_hash=g.term_hash and r.term=g.term);
 -- Only schema-declared opaque identities can consume numeric subcomponents.
 -- Free text (addresses, names, notes, approvals) is never an identity certificate.
 with source_ids as (
 select c.id::text value from public.customers c where c.workspace_id=p_workspace_id and (c.id=recipient or owner_scope)
 union select x.value from public.invoices i cross join lateral (values(i.id::text),(i.invoice_number),(i.metadata->>'printed_invoice_number'),(i.metadata->>'source_invoice_number')) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 union select x.value from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id cross join lateral (values(f.id::text),(f.storage_path)) x(value) where i.workspace_id=p_workspace_id and (i.customer_id=recipient or owner_scope)
 ) select array_agg(distinct k) into identities from source_ids cross join lateral unnest(app.private_dispatch_aliases(p_workspace_id,app.private_invoice_normalize(value),'generic',revision,memo_write)) k where k like 'identifier:%' and substring(k from 12) ~ '[0-9]' and substring(k from 12) ~ '[a-z]';
 return jsonb_build_object('files',coalesce((select jsonb_agg(to_jsonb(f)) from public.invoice_files f join public.invoices i on i.workspace_id=f.workspace_id and i.id=f.invoice_id where i.workspace_id=p_workspace_id and i.customer_id=recipient),'[]'::jsonb),'values',coalesce(allowed,array[]::text[]),'terms',coalesce(terms,array[]::text[]),'identifiers',coalesce(identities,array[]::text[]));
end $$;
revoke all on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_dispatch_privacy_snapshot(uuid,text) to service_role;
commit;
