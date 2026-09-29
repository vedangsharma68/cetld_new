-- Continue each workspace's established invoice-number convention.  Classification
-- is intentionally conservative: an unrecognised or evenly mixed history falls
-- back to INV-YYYY-NNNN rather than guessing.
create or replace function public.invoice_number_pattern(value text)
returns table (
  family text, pattern_key text, literal_prefix text, date_separator text,
  sequence_separator text, sequence_width integer, sequence_value bigint
)
language plpgsql immutable
set search_path = pg_catalog
as $$
declare
  parts text[];
begin
  -- Prefix + YYYY-MM-DD (also / and .) + separator + sequence.
  parts := regexp_match(value, '^(.*?)(20[0-9]{2})([-/.])([0-9]{2})\3([0-9]{2})([^0-9]+)([0-9]+)$');
  if parts is not null then
    return query select 'date_delimited', 'date-delimited:' || parts[1] || ':' || parts[3] || ':' || parts[6] || ':' || length(parts[7]),
      parts[1], parts[3], parts[6], length(parts[7]), parts[7]::bigint;
    return;
  end if;

  -- Prefix + YYYYMMDD + separator + sequence.
  parts := regexp_match(value, '^(.*?)(20[0-9]{2})([0-9]{2})([0-9]{2})([^0-9]+)([0-9]+)$');
  if parts is not null then
    return query select 'date_compact', 'date-compact:' || parts[1] || ':' || parts[5] || ':' || length(parts[6]),
      parts[1], '', parts[5], length(parts[6]), parts[6]::bigint;
    return;
  end if;

  -- Prefix + a clearly recognisable year + separator + sequence.
  parts := regexp_match(value, '^(.*?)(20[0-9]{2})([^0-9]+)([0-9]+)$');
  if parts is not null then
    return query select 'year', 'year:' || parts[1] || ':' || parts[3] || ':' || length(parts[4]),
      parts[1], '', parts[3], length(parts[4]), parts[4]::bigint;
    return;
  end if;

  -- A stable non-numeric prefix (including its punctuation) and trailing number.
  parts := regexp_match(value, '^(.*[^0-9])([0-9]+)$');
  if parts is not null then
    return query select 'prefix', 'prefix:' || parts[1] || ':' || length(parts[2]),
      parts[1], '', '', length(parts[2]), parts[2]::bigint;
    return;
  end if;

  if value ~ '^[0-9]+$' then
    if value ~ '^0[0-9]+$' then
      return query select 'integer', 'integer:padded:' || length(value), '', '', '', length(value), value::bigint;
    else
      return query select 'integer', 'integer:plain', '', '', '', 0, value::bigint;
    end if;
  end if;
end;
$$;

revoke all on function public.invoice_number_pattern(text) from public;

create or replace function public.assign_consistent_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source_number text := nullif(btrim(new.invoice_number), '');
  existing_number text;
  chosen record;
  next_value bigint;
  next_text text;
  current_year text := to_char(current_date, 'YYYY');
begin
  -- Preserve the original retry behavior before taking or consuming a number.
  if new.metadata->>'assistant_idempotency_key' is not null then
    select invoice_number into existing_number
    from public.invoices
    where workspace_id = new.workspace_id
      and metadata->>'assistant_idempotency_key' = new.metadata->>'assistant_idempotency_key'
    limit 1;
    if existing_number is not null then
      new.invoice_number := existing_number;
      return new;
    end if;
  end if;

  -- Serialize inference and allocation within a workspace.  Unlike a global
  -- sequence, this permits unrelated workspaces to insert concurrently.
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 92741));

  with recent as (
    select i.invoice_number, i.created_at,
      row_number() over (order by i.created_at desc, i.id desc) as recency_rank
    from public.invoices i
    where i.workspace_id = new.workspace_id
    order by i.created_at desc, i.id desc
    limit 100
  ), classified as (
    select r.*, p.*,
      case when recency_rank <= 10 then 4 when recency_rank <= 30 then 2 else 1 end as weight
    from recent r left join lateral public.invoice_number_pattern(r.invoice_number) p on true
  ), totals as (
    select coalesce(sum(weight), 0) as total_weight from classified
  ), patterns as (
    select family, pattern_key, literal_prefix, date_separator, sequence_separator,
      sequence_width, sum(weight) as score, count(*) as sample_count, max(created_at) as latest_at
    from classified where pattern_key is not null
    group by family, pattern_key, literal_prefix, date_separator, sequence_separator, sequence_width
  ), ranked as (
    select patterns.*, totals.total_weight,
      lead(score) over (order by score desc, sample_count desc, latest_at desc, pattern_key) as runner_score,
      row_number() over (order by score desc, sample_count desc, latest_at desc, pattern_key) as position
    from patterns cross join totals
  )
  select * into chosen from ranked where position = 1;

  -- A pattern must own a strict majority of recency-weighted history and must
  -- beat the runner-up. Unknown values count against that majority.
  if not found or chosen.score * 2 <= chosen.total_weight
     or chosen.score <= coalesce(chosen.runner_score, 0) then
    chosen.family := 'fallback';
    chosen.pattern_key := 'fallback:' || current_year;
    chosen.literal_prefix := 'INV-';
    chosen.sequence_separator := '-';
    chosen.sequence_width := 4;
  end if;

  if chosen.family = 'fallback' then
    select coalesce(max((regexp_match(invoice_number, '^INV-' || current_year || '-([0-9]+)$'))[1]::bigint), 0) + 1
      into next_value from public.invoices where workspace_id = new.workspace_id;
  else
    select coalesce(max(p.sequence_value), 0) + 1 into next_value
    from public.invoices i
    cross join lateral public.invoice_number_pattern(i.invoice_number) p
    where i.workspace_id = new.workspace_id and p.pattern_key = chosen.pattern_key;
  end if;

  next_text := case when chosen.sequence_width > 0 and length(next_value::text) < chosen.sequence_width
    then lpad(next_value::text, chosen.sequence_width, '0') else next_value::text end;
  new.invoice_number := case chosen.family
    when 'integer' then next_text
    when 'prefix' then chosen.literal_prefix || next_text
    when 'year' then chosen.literal_prefix || current_year || chosen.sequence_separator || next_text
    when 'date_compact' then chosen.literal_prefix || to_char(current_date, 'YYYYMMDD') || chosen.sequence_separator || next_text
    when 'date_delimited' then chosen.literal_prefix || to_char(current_date, 'YYYY') || chosen.date_separator
      || to_char(current_date, 'MM') || chosen.date_separator || to_char(current_date, 'DD') || chosen.sequence_separator || next_text
    else 'INV-' || current_year || '-' || next_text
  end;

  if source_number is not null and source_number <> 'AUTO' then
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object('source_invoice_number', source_number);
  end if;
  return new;
end;
$$;

revoke all on function public.assign_consistent_invoice_number() from public;

-- The trigger already points at this function; recreate it explicitly so this
-- migration is self-contained on databases with an interrupted prior deploy.
drop trigger if exists assign_consistent_invoice_number on public.invoices;
create trigger assign_consistent_invoice_number
before insert on public.invoices
for each row execute function public.assign_consistent_invoice_number();
