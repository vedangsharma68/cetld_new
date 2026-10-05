-- LOCAL APPROVAL PROPOSAL: invoice-number-only attachment review override.
-- No ledger write; the existing scoped numbering trigger assigns the unique number.
begin;
create or replace function public.whatsapp_override_invoice_review_number(
  p_workspace_id uuid, p_owner_id uuid, p_phone text, p_id bigint, p_version bigint,
  p_provider_message_id text, p_authorization_quote text, p_number text, p_intent text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_owner record; v_pending public.whatsapp_pending_actions%rowtype;
  v_event public.whatsapp_inbound_events%rowtype; v_audit jsonb;
begin
  if p_number is null or length(p_number) not between 1 and 100 or p_number<>btrim(p_number)
    or p_number ~ '[[:cntrl:]]' or p_provider_message_id is null
    or length(p_provider_message_id) not between 1 and 256
    or p_authorization_quote is null or length(p_authorization_quote) not between 1 and 4000
    or p_intent is distinct from 'use_workspace_numbering' or p_number is distinct from 'AUTO' then
    return jsonb_build_object('ok',false,'code','INVALID');
  end if;
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
      where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id)<>1 then
    return jsonb_build_object('ok',false,'code','DENIED');
  end if;
  select r.* into v_owner from public.whatsapp_resolve_verified_owner(p_phone) r
    where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id;
  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
      where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id and r.customer_id=v_owner.customer_id)<>1 then
    return jsonb_build_object('ok',false,'code','DENIED');
  end if;
  select * into v_pending from public.whatsapp_pending_actions p where p.id=p_id
    and p.workspace_id=p_workspace_id and p.customer_id=v_owner.customer_id and p.phone=p_phone
    and p.consumed_at is null and p.expires_at>now() for update;
  if not found then return jsonb_build_object('ok',false,'code','STALE'); end if;
  select * into v_event from public.whatsapp_inbound_events e
    where e.provider_message_id=p_provider_message_id and e.sender_phone=p_phone
    and e.status in ('processing','done') for update;
  if not found or v_event.message_text is distinct from p_authorization_quote
    or v_event.created_at<v_pending.created_at
    or p_provider_message_id=v_pending.action->>'sourceMessageId' then
    return jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');
  end if;
  v_audit:=v_pending.action->'invoiceNumberOverrideAudit';
  if v_audit is not null then
    if v_audit->>'ownerMessageId'=p_provider_message_id and v_audit->>'requestedNumber'=p_number
      and v_audit->>'intent'=p_intent and v_audit->>'ownerInstruction'=p_authorization_quote then
      return jsonb_build_object('ok',true,'replayed',true,'review',to_jsonb(v_pending));
    end if;
    return jsonb_build_object('ok',false,'code','NUMBER_OVERRIDE_ALREADY_RECORDED');
  end if;
  if v_event.status<>'processing' or v_pending.version is distinct from p_version
    or v_pending.action->>'type' is distinct from 'invoice_review_draft'
    or v_pending.action->>'stage' is null or v_pending.action->>'stage' not in ('incomplete','proposal')
    or nullif(v_pending.action->>'sourceMessageId','') is null
    or nullif(v_pending.action->'invoice'->>'invoiceNumber','') is null
    or v_pending.action->'invoice'->>'invoiceNumber'='AUTO'
    or v_pending.action->'ownerProvidedFacts' ? 'invoiceNumber'
    or v_pending.action->'missingFields' ? 'invoiceNumber' then
    return jsonb_build_object('ok',false,'code','STALE');
  end if;
  v_audit:=jsonb_build_object('originalExtractedNumber',v_pending.action->'invoice'->>'invoiceNumber',
    'requestedNumber',p_number,'intent',p_intent,'ownerMessageId',p_provider_message_id,
    'ownerInstruction',p_authorization_quote,'sourceMessageId',v_pending.action->>'sourceMessageId',
    'recordedAt',now());
  update public.whatsapp_pending_actions p set version=p.version+1,
    action=jsonb_set(p.action,'{invoice,invoiceNumber}',to_jsonb(p_number))
      ||jsonb_build_object('invoiceNumberOverrideAudit',v_audit)
    where p.id=v_pending.id returning p.* into v_pending;
  return jsonb_build_object('ok',true,'replayed',false,'review',to_jsonb(v_pending));
end $$;
revoke all on function public.whatsapp_override_invoice_review_number(uuid,uuid,text,bigint,bigint,text,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_override_invoice_review_number(uuid,uuid,text,bigint,bigint,text,text,text,text) to service_role;
commit;
