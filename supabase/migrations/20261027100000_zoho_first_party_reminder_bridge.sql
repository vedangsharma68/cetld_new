-- Exact first-party Zoho origin/epoch claim-to-final bridge. Generic gates stay closed.
begin;
set local search_path=pg_catalog,public;
do $guard$
declare r record; p oid;
begin
 for r in select * from (values
 ('app.invoice_has_external_ledger(public.invoices)',array['80321aeca14fc9c5f333f74ab938ff238a99869b7645edabb91235a4e6dfecde']),
 ('app.reminder_external_read_matches(public.invoices,uuid)',array['cbe9a66a4d8fb965f211cae88723eb9fdaa89030185bc4776bc340f4f753058e']),
 ('app.reminder_local_status_payable(public.invoices)',array['cf7a45a506f61501b5c6f229e297a9d46585a0fd193c54278057206c66df67da']),
 ('public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)',array['c6a34979b74fd37d80aa5f133bd2bd33157deda76a1fe374743d7351e070c6a3','515a146cfc808f3bcfc8290a9fa883d9d5d725649c696b656e34964cd868b687','7682bf8e74ce798442b3054f4672e888c952dce4fce70c31a80554606e1ab6ef']),
 ('public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)',array['f8c636e89460d6107b0f009c893c1e02a2a5d155f10c9f6ee66ba405d01e5876','3f73ac01580326a2106f9529c8794f59607a205e7a8d86e96febe51095eabcb4','a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df']),
 ('public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text)',array['fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110'])
,
 ('app.has_invoice_total_correction_context(uuid)',array['5b53eee3ad8c388ff0f29929e11b072efd1bb57fcc66f9373965640bad6155ad']),
 ('app.apply_owner_invoice_correction(uuid,uuid,uuid,timestamptz,jsonb,text,text)',array['0f287de4b01b1a334d73e7d6e0e50ce292ad7419c1d6962167054d49d22d0449']),
 ('app.admit_accounting_invoice_insert()',array['881380398dd689c2096d45e8772edfed4364ce3b0dc6b11e0cfc1a341ecdc015']),
 ('app.track_accounting_connection_epoch()',array['546976eeae6c0629f5b27b1cd38eb64a8368bde26234c7cae1ebb9892fd25fc5']),
 ('public.cetld_zoho_operation_context(uuid,uuid)',array['8b6e02843dbe8bb44115e382ac02161e39921a70813d83b57bb56e4309785106']),
 ('public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid)',array['ddb82ed9446b67650eac92ff12c79e397296facfe43a247888d21b6535c7e28d']),
 ('public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text)',array['8fa84c5c3e4593f5d47acbea993c3ffe03e0e5642dcc01c61f28700ec276011e'])
,
 ('app.fence_old_zoho_export_journal()',array['7251a86ee41eadfe50d2a018d29cbecb30921230db0ec68c134faf6de062fe3a']),
 ('app.fence_zoho_capture_candidate()',array['ac7167eca0e297b75fc36acf690189764e0054980e087e58eb000f32d3767d0e']),
 ('app.guard_zoho_bound_customer()',array['8f6e33e0cdf72a3497a3353a5e6d532f1b3ef51e71bd9c6a1dda31a46a667fef']),
 ('app.guard_zoho_bound_invoice()',array['6a3ea57db81270a75667c9bae7bb68af15c5fdb34230d6d23ac9a09dac07f58f']),
 ('app.guard_zoho_customer_origin()',array['15dd360f944bdf228b50d515eb2ef7fc3e836d3456d4df687cc952f80a68bc1a']),
 ('app.guard_zoho_origin()',array['67447599b7c2baef5c975ce47fc28a247b7a0429f71693eb64bb5eac3c42f706']),
 ('public.cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamp with time zone,bigint,uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,date,date,text,text)',array['639642afa5ba4c61119d9146bdf1fac1a940de8b5f97838452e6faaa1fc5f8ec'])
,
 ('public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid)',array['273f1fc397a0505ba49e97d7e6625fa63da86acef1f813dab208434335270dbd'])
 ) s(signature,hashes) loop
  p:=to_regprocedure(r.signature);
  if p is null or not encode(sha256(convert_to(pg_get_functiondef(p),'UTF8')),'hex')=any(r.hashes) then
   raise exception 'capture protocol predecessor source drift: %',r.signature;end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid=p)<>'postgres'
   or (r.signature like 'public.%' and not has_function_privilege('service_role',p,'EXECUTE')) then
   raise exception 'capture protocol predecessor owner/ACL drift: %',r.signature;end if;
  if exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   where f.oid=p and a.grantee<>f.proowner and
    (r.signature not like 'public.%' or a.grantee<>'service_role'::regrole or a.is_grantable)) then
   raise exception 'capture protocol predecessor ACL drift: %',r.signature;end if;
 end loop;
 -- Reuse only the installed private owner-correction permit. Neither JWT/GUC
 -- claims nor service DML may manufacture it. Preserve its existing ACL/schema.
 if not exists(select 1 from pg_class where oid='app.invoice_total_correction_context'::regclass
   and relkind='r' and pg_get_userbyid(relowner)='postgres')
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='app.invoice_total_correction_context'::regclass and a.grantee<>c.relowner)
  or exists(select 1 from pg_attribute t cross join lateral aclexplode(t.attacl) a
   where t.attrelid='app.invoice_total_correction_context'::regclass and a.grantee<>'postgres'::regrole) then
  raise exception 'capture protocol owner correction context ACL drift';end if;
 if not (select relrowsecurity and pg_get_userbyid(relowner)='postgres' from pg_class where oid='public.cetld_accounting_connections'::regclass)
  or has_any_column_privilege('authenticated','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('authenticated','public.cetld_accounting_connections','DELETE')
  or has_any_column_privilege('anon','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('anon','public.cetld_accounting_connections','DELETE') then
  raise exception 'capture protocol connection protection drift';end if;
 if (select pg_get_userbyid(nspowner) from pg_namespace where nspname='app')<>'postgres' or
 exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
  where n.nspname='app' and a.privilege_type='CREATE' and a.grantee<>n.nspowner) then
  raise exception 'capture protocol private schema CREATE drift';end if;
end $guard$;
do $private$
begin
 if (select count(*) from pg_class c where c.oid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,
   'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres')<>4
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.grantee<>c.relowner)
  or exists(select 1 from pg_attribute t cross join lateral aclexplode(t.attacl) a
   where t.attrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.grantee<>'postgres'::regrole)
  or (select count(*) from (values
   ('app.zoho_invoice_origins','zoho_origin_immutable','app.guard_zoho_origin()'),
   ('app.zoho_customer_origins','zoho_customer_origin_immutable','app.guard_zoho_customer_origin()'),
   ('public.invoices','zoho_bound_invoice','app.guard_zoho_bound_invoice()'),
   ('public.customers','zoho_bound_customer','app.guard_zoho_bound_customer()'),
   ('public.invoices','zoho_capture_candidate_fence','app.fence_zoho_capture_candidate()'),
   ('app.zoho_export_operations','zoho_old_worker_capture_fence','app.fence_old_zoho_export_journal()')
  ) expected(relation,name,func) join pg_trigger t on t.tgrelid=to_regclass(expected.relation)
   and t.tgname=expected.name and t.tgfoid=to_regprocedure(expected.func) and t.tgenabled='O')<>6
  or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid),c.convalidated)
   order by c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid))::text,'UTF8')),'hex') from pg_constraint c
   where c.conrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and c.contype in ('c','p','u','f'))
   is distinct from '4e724a814f77fd0002fa4ccf59637e10c31efcf292ab75b20e20e9f5bb41660a'
  -- PG versions differ in whether NOT NULL also appears as contype='n'.
  -- Independently protect every column/type/NOT NULL flag via pg_attribute;
  -- ignore no attribute merely because its constraint catalog row is absent.
  or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attnum,a.attname,
   format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated) order by a.attrelid::regclass::text,a.attnum)::text,'UTF8')),'hex')
   from pg_attribute a where a.attrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,
    'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.attnum>0 and not a.attisdropped)
   is distinct from '8f3a72a36de67e045982275071a34cba02f62c7ac614a7f59b331a435e55b9ee' then
  raise exception 'original read private protection drift';end if;
end $private$;

-- This successor binds private journals to exact first-party core attempts.
-- Generic gates stay closed; no installation business DML/backfill.
do $guard$
declare r record; p oid;
begin
 for r in select * from (values
 ('cetld_core_record_first_party_receipt(text,text,text,text,text,text)','d0071207a0d762be1c3b58be9cf7d4ba9bf2b44f25c1c99637a1f2c3dabfe948','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.evaluate_reviewed_reminder(uuid,uuid,uuid,uuid,jsonb,text,boolean)','b756d238fefcbef28d0289fcb055930e27f8bfa1e926493559939c10bce49d50','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('cetld_core_claim_due_followups(uuid,uuid,timestamp with time zone,integer,uuid)','515a146cfc808f3bcfc8290a9fa883d9d5d725649c696b656e34964cd868b687|7682bf8e74ce798442b3054f4672e888c952dce4fce70c31a80554606e1ab6ef','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamp with time zone,bigint,uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,date,date,text,text)','639642afa5ba4c61119d9146bdf1fac1a940de8b5f97838452e6faaa1fc5f8ec','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.owner_assistant_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean)','d7abd26a72d4bb737a8c99bc585b3eac832e4289a327857b05834e58b688fe16','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)','286ea00f8e2ebf9bf843bc13bf45fd2d9884e4208d523185ef11abe50469746a','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('cetld_core_authorize_delivery(uuid,uuid,uuid,timestamp with time zone)','3f73ac01580326a2106f9529c8794f59607a205e7a8d86e96febe51095eabcb4|a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.guard_zoho_bound_invoice()','6a3ea57db81270a75667c9bae7bb68af15c5fdb34230d6d23ac9a09dac07f58f','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.owner_assistant_reminder_template_gate(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean)','5ca9b33071c214441303855f6e059818add67301c87d50450a1237c54e4a7c82','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('cetld_core_check_local_reminder_payment(uuid,uuid,uuid)','3a7a4acf4ec6d959edf3e3f47b17be65ae285cec40decedd651f2e235cf2ec9c','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.zoho_bound_claim_protocol(uuid,uuid,uuid,text,uuid,uuid,uuid,text,jsonb,text,text)','5e52475aef46651ee3f6afcfe15d839cc6b4de2a1e89fc9748a29f6803ef5ae7','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.invalidate_zoho_bound_claims()','3d3aa42cfd79227c46b4998f19c05587a5c74baf1b3fe598856503d65022f3f0','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.reminder_window_deadline(uuid,uuid,text)','01b5e64ed72feecad18a15de576a660c8d75f5a5ed610d96e93f2dd12f96bd46','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.reminder_template_core(jsonb)','11047298483e64b08da6e015770006fdc421a9306000eac2d425ac249273be32','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.review_approval_text(text,text)','d13203e48e8d1a182d1037439249df3406f29e285b40a8f5c264e8e9f97f871c','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.checked_reminder_template(invoices,workspace_settings,customers,jsonb)','024d64dd51bb2a55687f44e00841d8d5ffd6f52b50650daa920993c4d17961a5','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.core_next_contact(timestamp with time zone,jsonb,text)','2fdc6ffcbe2db4fdadbeb61f06267a9afa9e4aa19e79f1925289a9140de10f19','[["PUBLIC","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.require_branded_reminder_approval()','bbcb5e185adfa7525e6be3f74ae6dd348a799a12b0dba8fd02e3b154e00256c8','[["PUBLIC","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.first_party_receipt_audit_guard()','d6d78983e7ddf154eaf4ebd37e8307630691c4b2af5d872e493e4143fe1fc120','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.cancel_first_party_phone(text,uuid)','35a59393854fcfb7feb2467c4302a218770d73d932d8271a82c80cc270728e5a','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.first_party_suppression_hook()','744d82c4e74e14de86603e21149ccdfae7dce80256dd428c603d439df20381c7','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.reminder_canonical_json(jsonb)','bde651fce09364013aad52c1994d9d500d0b863ed6a87a6957563f86cfd3cdeb','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.first_party_consent_phone_lock()','22bda9228eacde94ad8d456bae0a0a87a7012d10722b7318821f88a1c082028a','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.reminder_outstanding_text(numeric,text)','f94c7eff5102639542c0dc8a9f1898ffdfc4e4181d6b44923e534253f932a3fa','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.sync_core_followup_invoice()','3a8fa359ab25bd0a7a61001b08418cd59cf43b08b8e7ca7ab2e81eeb5f07e264','[["PUBLIC","postgres","EXECUTE",false],["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.owner_assistant_authorized(uuid,uuid)','394ae931ae7aaddcf2a85b770481d8027501d39e6bc450523e3e5aec0a6a5583','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.evaluate_reminder_form(jsonb,timestamp with time zone,timestamp with time zone)','c2835eb28a5ffdac29a66c544d3b4974e9ac967b198a18d609df65e437150dda','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.legacy_reminder_approval_matches(uuid,invoices)','5f6f096cf89040c2682cdf299d105694f4f913c98b9c6ad99f91e2c0dc836415','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.reminder_artifact_text(jsonb,text,text)','5c206f7812c84cf7cffd2efc37597db3afd7c7ee1aea3f695715426bed0001bc','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.invalidate_core_followup_approvals()','997f9179326571753b121a72763860687962694e871fc7ade2b2ed9e3eaee1b3','[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::jsonb),
 ('app.guard_test_invoice()','ba9a113afc12cd2c78b4a563a2d649fae65ed80f1a76547ad25820bcfdf3a989','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.guard_test_invoice_customer()','f46ccb689d73c810f7c08702060298df3f78f4990bbd1162c85db9376e9f24c0','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.guard_zoho_bound_claim()','d0e31fc4c7e241d917f278b2cb41eedd1f16f009c15df33fcff9403807f67ecb','[["postgres","postgres","EXECUTE",false]]'::jsonb),
 ('app.zoho_bound_claim_frame(uuid,uuid,uuid)','3e554ad165e2c9c91cb51db25f66e4324c55dfeee8f0087347c0c94839623010','[["postgres","postgres","EXECUTE",false]]'::jsonb)
 ) expected(signature,hash,acl) loop
 p:=to_regprocedure(r.signature);
 if p is null or not encode(sha256(convert_to(pg_get_functiondef(p),'UTF8')),'hex')=any(string_to_array(r.hash,'|')) then raise exception 'Zoho bridge predecessor drift: %',r.signature;end if;
 if (select pg_get_userbyid(proowner) from pg_proc where oid=p)<>'postgres' then raise exception 'Zoho bridge owner drift';end if;
 if (select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,pg_get_userbyid(a.grantor),a.privilege_type,a.is_grantable) order by a.grantee::regrole::text,a.privilege_type) from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where f.oid=p) is distinct from r.acl then raise exception 'Zoho bridge predecessor ACL drift: %',r.signature;end if;
 end loop;
end $guard$;

do $journal_protection$
begin
 if (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(n.nspname||'.'||c.relname,t.tgname,pn.nspname||'.'||p.proname,t.tgtype,t.tgenabled,t.tgattr::text,encode(t.tgargs,'hex'),pg_get_expr(t.tgqual,t.tgrelid)) order by n.nspname,c.relname,t.tgname)::text,'UTF8')),'hex')
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
 where not t.tgisinternal and pn.nspname='app' and p.proname in ('guard_zoho_origin','guard_zoho_customer_origin','guard_zoho_bound_invoice','guard_zoho_bound_customer',
 'fence_zoho_capture_candidate','fence_old_zoho_export_journal','admit_accounting_invoice_insert','track_accounting_connection_epoch','guard_zoho_bound_claim','invalidate_zoho_bound_claims',
 'guard_test_invoice','guard_test_invoice_customer','require_branded_reminder_approval','first_party_suppression_hook','first_party_consent_phone_lock','sync_core_followup_invoice','invalidate_core_followup_approvals'))
 is distinct from '365e9a3337b16054e0e26f1b18766d61ec55a8813c719dd2ad1f081193a9de4b' then raise exception 'Zoho bridge active trigger definition drift';end if;
 if (select count(*) from pg_class where oid in ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass)
  and relrowsecurity and pg_get_userbyid(relowner)='postgres')<>3
 or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid in
  ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass) and a.grantee<>c.relowner)
 or exists(select 1 from pg_attribute c cross join lateral aclexplode(c.attacl) a where c.attrelid in
  ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass) and a.grantee<>'postgres'::regrole)
 or exists(select 1 from pg_policy where polrelid in ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass))
 or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid),c.convalidated)
  order by c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid))::text,'UTF8')),'hex') from pg_constraint c where c.conrelid in
  ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass) and c.contype in ('c','p','u','f'))
 is distinct from '89b715bfd5cb2aa5328d160f808d278dc7504e1534d7effe3a6aa19db7e8fece'
 or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated)
  order by a.attrelid::regclass::text,a.attnum)::text,'UTF8')),'hex') from pg_attribute a where a.attrelid in
  ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_receipts'::regclass,'app.zoho_bound_claim_write_context'::regclass) and a.attnum>0 and not a.attisdropped)
 is distinct from '6128cb8ac69188093275a549e6c9d7084ac19def04887df4061c2bcfac37ba86'
 or (select count(*) from (values
  ('app.zoho_bound_claims','zoho_bound_claim_guard','app.guard_zoho_bound_claim()'),
  ('app.zoho_bound_claim_receipts','zoho_bound_receipt_guard','app.guard_zoho_bound_claim()'),
  ('public.invoices','zoho_claim_invoice_changed','app.invalidate_zoho_bound_claims()'),
  ('public.customers','zoho_claim_customer_changed','app.invalidate_zoho_bound_claims()'),
  ('public.workspace_settings','zoho_claim_settings_changed','app.invalidate_zoho_bound_claims()'),
  ('public.workspaces','zoho_claim_workspace_changed','app.invalidate_zoho_bound_claims()'),
  ('public.whatsapp_consents','zoho_claim_consent_changed','app.invalidate_zoho_bound_claims()'),
  ('public.whatsapp_suppressions','zoho_claim_stop_changed','app.invalidate_zoho_bound_claims()'),
  ('public.whatsapp_global_suppressions','zoho_claim_global_stop_changed','app.invalidate_zoho_bound_claims()'),
  ('app.accounting_connection_epochs','zoho_claim_epoch_changed','app.invalidate_zoho_bound_claims()')
 ) expected(relation,name,func) join pg_trigger t on t.tgrelid=to_regclass(expected.relation) and t.tgname=expected.name and t.tgfoid=to_regprocedure(expected.func) and t.tgenabled='O')<>10 then
 raise exception 'Zoho bridge journal catalog/security/trigger drift';end if;
end $journal_protection$;

create table app.zoho_reminder_transaction_context(
 backend_pid integer not null,transaction_id bigint not null,invoice_id uuid not null,owner_id uuid not null,
 stage text not null check(stage in ('approval','claim','payment','authorize','final','receipt','failure')),journal_id uuid,
 primary key(backend_pid,transaction_id,invoice_id));
create table app.zoho_reminder_core_bindings(
 core_claim_id uuid primary key references public.cetld_core_automation_delivery_claims(id),
 journal_id uuid not null unique references app.zoho_bound_claims(id),
 created_at timestamptz not null default clock_timestamp());
alter table app.zoho_reminder_transaction_context enable row level security;
alter table app.zoho_reminder_core_bindings enable row level security;
revoke all on app.zoho_reminder_transaction_context,app.zoho_reminder_core_bindings from public,anon,authenticated,service_role;

create function app.zoho_reminder_context_payable(i public.invoices,p_owner uuid default null) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare t app.zoho_reminder_transaction_context;c app.zoho_bound_claims;x jsonb;
begin
 select * into t from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=i.id;
 if t.invoice_id is null or p_owner is not null and t.owner_id<>p_owner or i.status not in ('sent','overdue') then return false;end if;
 if t.stage='receipt' then
  return exists(select 1 from app.zoho_bound_claims b join app.zoho_invoice_origins o on o.invoice_id=b.invoice_id and o.operation_id=b.origin_operation_id
   where b.id=t.journal_id and b.invoice_id=i.id and b.workspace_id=i.workspace_id and b.customer_id=i.customer_id
   and b.external_invoice_id=i.external_invoice_id and i.external_provider='zoho_books' and b.posting_started_at is not null);
 end if;
 x:=public.cetld_zoho_original_bound_read_context(t.owner_id,i.workspace_id,i.id);
 if x is null then return false;end if;
 if t.stage='approval' then return true;end if;
 select * into c from app.zoho_bound_claims where id=t.journal_id;
 return c.owner_id=t.owner_id and c.workspace_id=i.workspace_id and c.invoice_id=i.id
 and c.frame=app.zoho_bound_claim_frame(t.owner_id,i.workspace_id,i.id)
 and c.expires_at>clock_timestamp() and c.state in ('claimed','challenged','reserved','posting');
end $$;
revoke all on function app.zoho_reminder_context_payable(public.invoices,uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_payment(p_owner_id uuid, p_workspace_id uuid, p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i public.invoices%rowtype; net numeric;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return '{"ok":false,"reason":"scope"}';end if;
  select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id for update;
  if i.id is null or i.deleted_at is not null then return '{"ok":false,"reason":"invoice_unavailable"}';end if;
  if i.metadata->>'invoice_direction' is distinct from 'receivable' then return '{"ok":false,"reason":"invoice_direction"}';end if;
  -- Keep this optional proposal standalone: mirror all authoritative linkage
  -- markers without depending on the separately reviewed owner guard helper.
  -- Custom fields are owner labels, never accounting authority.
  if (nullif(btrim(i.external_provider),'') is not null
    or nullif(btrim(i.external_invoice_id),'') is not null
    or nullif(btrim(i.metadata->>'accounting_provider'),'') is not null
    or nullif(btrim(i.metadata->>'bookkeeping_record_id'),'') is not null
    ) and not app.zoho_reminder_context_payable(i,p_owner_id) then return '{"ok":false,"reason":"external_accounting_required"}';end if;
  if exists(select 1 from public.payment_reversals r left join public.payments p on p.workspace_id=r.workspace_id and p.id=r.payment_id
    where r.workspace_id=p_workspace_id and (r.invoice_id=p_invoice_id or p.invoice_id=p_invoice_id) and (p.id is null or p.invoice_id<>r.invoice_id or p.amount<>r.amount))
    then return '{"ok":false,"reason":"payment_audit_mismatch"}';end if;
  select coalesce(sum(case when r.id is null then p.amount else 0 end),0) into net
    from public.payments p left join public.payment_reversals r on r.workspace_id=p.workspace_id and r.payment_id=p.id
    where p.workspace_id=p_workspace_id and p.invoice_id=p_invoice_id;
  if net<>i.amount_paid or net>i.total_amount then return '{"ok":false,"reason":"payment_balance_mismatch"}';end if;
  return jsonb_build_object('ok',true,'paidMinor',net*100,'invoiceVersion',i.automation_version);
end $function$
;
revoke all on function app.zoho_reminder_payment(uuid,uuid,uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_claim(p_owner_id uuid, p_workspace_id uuid, p_now timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 25, p_invoice_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(claim_id uuid, invoice_id uuid, invoice_version bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare candidate record;i public.invoices%rowtype;s public.workspace_settings%rowtype;c public.cetld_core_automation_delivery_claims%rowtype;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return;end if;
  for candidate in select v.id,x.phone from public.invoices v left join public.customers x on x.workspace_id=v.workspace_id and x.id=v.customer_id
    where v.workspace_id=p_workspace_id and (p_invoice_id is null or v.id=p_invoice_id) and v.next_follow_up_at<=p_now
    and (not (nullif(btrim(v.external_provider),'') is not null or nullif(btrim(v.external_invoice_id),'') is not null or nullif(btrim(v.metadata->>'accounting_provider'),'') is not null or nullif(btrim(v.metadata->>'bookkeeping_record_id'),'') is not null) or app.zoho_reminder_context_payable(v,p_owner_id)) and v.followup_state in ('approved','active','scheduled') and v.deleted_at is null
    order by x.phone collate "C",v.id limit greatest(1,least(p_limit,100))
  loop
    if candidate.phone is null or candidate.phone !~ '^\+[1-9][0-9]{7,14}$' then continue;end if;
    if candidate.phone is not null then perform pg_advisory_xact_lock(hashtextextended(candidate.phone,0));end if;
    select * into i from public.invoices where id=candidate.id and workspace_id=p_workspace_id for update skip locked;
    select * into s from public.workspace_settings where workspace_id=p_workspace_id;
    if i.id is null or ((nullif(btrim(i.external_provider),'') is not null or nullif(btrim(i.external_invoice_id),'') is not null or nullif(btrim(i.metadata->>'accounting_provider'),'') is not null or nullif(btrim(i.metadata->>'bookkeeping_record_id'),'') is not null) and not app.zoho_reminder_context_payable(i,p_owner_id)) or i.deleted_at is not null or i.followup_state not in ('approved','active','scheduled') or i.next_follow_up_at>p_now
      or i.next_follow_up_at is null or i.amount_paid>=i.total_amount or i.total_amount<=0 or i.status::text in ('paid','void','cancelled')
      or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable'
      or nullif(btrim(i.metadata->>'approved_reminder_text'),'') is null
      or app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at') is distinct from s.updated_at
      or not exists(select 1 from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id and x.phone=candidate.phone)
      or exists(select 1 from public.whatsapp_global_suppressions where phone=candidate.phone)
      or exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=candidate.phone) then continue;end if;
    insert into public.cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
      values(p_workspace_id,i.id,i.next_follow_up_at,i.automation_version,s.updated_at,'claimed',p_now+interval '2 minutes')
    on conflict on constraint core_followup_claim_unique do update set invoice_version=excluded.invoice_version,preferences_updated_at=excluded.preferences_updated_at,
      status='claimed',attempts=public.cetld_core_automation_delivery_claims.attempts+1,lease_until=excluded.lease_until,delivery_token=null
      where public.cetld_core_automation_delivery_claims.attempts<3
      and not exists(select 1 from app.first_party_reminder_dispatches d where d.claim_id=public.cetld_core_automation_delivery_claims.id)
      and (public.cetld_core_automation_delivery_claims.status in ('failed','cancelled') or
        (public.cetld_core_automation_delivery_claims.status='claimed' and public.cetld_core_automation_delivery_claims.lease_until<p_now)) returning * into c;
    if found then claim_id:=c.id;invoice_id:=c.invoice_id;invoice_version:=c.invoice_version;return next;end if;
  end loop;
end $function$
;
revoke all on function app.zoho_reminder_claim(uuid,uuid,timestamp with time zone,integer,uuid) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_authorize(p_claim_id uuid, p_owner_id uuid, p_workspace_id uuid, p_preferences_version timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(authorized boolean, reason text, token uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.cetld_core_automation_delivery_claims%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;target_phone text;
begin
  authorized:=false;reason:='not_found';token:=null;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return next;return;end if;
  select v.* into i from public.invoices v join public.cetld_core_automation_delivery_claims d on d.workspace_id=v.workspace_id and d.invoice_id=v.id
    where d.id=p_claim_id and d.workspace_id=p_workspace_id;
  select x.phone into target_phone from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id;
  if target_phone is null or target_phone !~ '^\+[1-9][0-9]{7,14}$' then reason:='missing_contact';return next;return;end if;
  if target_phone is not null then perform pg_advisory_xact_lock(hashtextextended(target_phone,0));end if;
  select * into i from public.invoices where id=i.id and workspace_id=p_workspace_id for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id;
  if c.id is null or i.id is null or s.workspace_id is null then return next;return;end if;
  if c.status<>'claimed' then reason:='not_claimed';return next;return;end if;
  if c.invoice_version<>i.automation_version or c.preferences_updated_at<>s.updated_at or (p_preferences_version is not null and p_preferences_version<>s.updated_at)
    then reason:='stale_claim';return next;return;end if;
  if c.lease_until<=clock_timestamp() then reason:='expired';return next;return;end if;
  if i.deleted_at is not null or i.followup_state not in ('approved','active','scheduled') or ((nullif(btrim(i.external_provider),'') is not null or nullif(btrim(i.external_invoice_id),'') is not null or nullif(btrim(i.metadata->>'accounting_provider'),'') is not null or nullif(btrim(i.metadata->>'bookkeeping_record_id'),'') is not null) and not app.zoho_reminder_context_payable(i,p_owner_id)) or i.status::text in ('paid','void','cancelled')
    or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable'
    or nullif(btrim(i.metadata->>'approved_reminder_text'),'') is null
    or app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at') is distinct from s.updated_at
    or not exists(select 1 from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id and x.phone=target_phone)
    or exists(select 1 from public.whatsapp_global_suppressions q where q.phone=target_phone)
    or exists(select 1 from public.whatsapp_suppressions q where q.workspace_id=p_workspace_id and q.phone=target_phone)
    then reason:='ineligible_invoice';return next;return;end if;
  if i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then reason:='reminder_limit';return next;return;end if;
  if app.core_next_contact(clock_timestamp(),s.follow_up_preferences,s.default_timezone)>clock_timestamp()+interval '1 second'
    then reason:='contact_hours';return next;return;end if;
  token:=gen_random_uuid();authorized:=true;reason:=null;
  update public.cetld_core_automation_delivery_claims set status='sending',delivery_token=token where id=c.id;return next;
end $function$
;
revoke all on function app.zoho_reminder_authorize(uuid,uuid,uuid,timestamp with time zone) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_final(p_owner_id uuid, p_workspace_id uuid, p_claim_id uuid, p_snapshot jsonb, p_snapshot_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i public.invoices%rowtype; c public.cetld_core_automation_delivery_claims%rowtype;
  s public.workspace_settings%rowtype; x public.customers%rowtype; o public.whatsapp_consents%rowtype;
  t app.first_party_reminder_templates%rowtype; facts jsonb; body text; token text; n integer; payment jsonb;review_result jsonb;
begin
  if jsonb_typeof(p_snapshot)<>'object' or length(p_snapshot::text)>32768 or p_snapshot_hash !~ '^[a-f0-9]{64}$'
    then return '{"authorized":false}';end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return '{"authorized":false}';end if;
  if p_snapshot->>'phone' !~ '^\+[1-9][0-9]{7,14}$' then return '{"authorized":false}';end if;
  -- Same phone advisory lock already used by active-consent and all STOP RPCs.
  perform pg_advisory_xact_lock(hashtextextended(p_snapshot->>'phone',0));
  -- Settings before invoice: preference invalidation holds settings then invoices.
  -- STOP never locks settings; invoice remains before claim in both paths.
  select * into s from public.workspace_settings where workspace_id=p_workspace_id for share;
  -- Match tone invalidation's customer -> invoice lock order.
  select * into x from public.customers where workspace_id=p_workspace_id
    and id=(select customer_id from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid) for share;
  select * into i from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  if x.id is null or x.id is distinct from i.customer_id then return '{"authorized":false}';end if;
  -- Consent writes acquire the same phone advisory lock; an MVCC read avoids
  -- row-lock -> advisory inversion inside BEFORE consent triggers.
  select * into o from public.whatsapp_consents where workspace_id=p_workspace_id and customer_id=x.id and phone=x.phone;
  if i.metadata#>>'{approved_reminder_delivery,version}' is distinct from '2' and length(p_snapshot::text)>8000 then return '{"authorized":false}';end if;
  if i.id is null or c.id is null or c.invoice_id<>i.id or c.status<>'sending' or c.delivery_token is null or c.lease_until<=clock_timestamp()
    or i.automation_version<>c.invoice_version or s.updated_at<>c.preferences_updated_at or i.deleted_at is not null
    or not app.zoho_reminder_context_payable(i) or i.metadata->>'invoice_direction' is distinct from 'receivable' or i.amount_paid>=i.total_amount
    or i.total_amount<=0 or i.due_date is null or i.followup_state not in ('approved','active','scheduled')
    or i.next_follow_up_at is null or i.next_follow_up_at>clock_timestamp()
    or x.phone is distinct from p_snapshot->>'phone' or x.id::text is distinct from p_snapshot->>'customerId'
    or o.id is null or o.revoked_at is not null or o.source not in ('verbal','inbound_message') or not ('invoice_updates'=any(o.categories))
    or o.id::text is distinct from p_snapshot->>'consentId' or o.created_at is distinct from (p_snapshot->>'consentCreatedAt')::timestamptz
    or i.updated_at is distinct from (p_snapshot->>'invoiceUpdatedAt')::timestamptz
    or i.automation_version::text is distinct from p_snapshot->>'invoiceVersion'
    or s.updated_at is distinct from (p_snapshot->>'preferencesUpdatedAt')::timestamptz
    or s.updated_at is distinct from (i.metadata->>'approved_preferences_updated_at')::timestamptz
    or exists(select 1 from public.whatsapp_global_suppressions where phone=x.phone)
    or exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=x.phone)
    then return '{"authorized":false}';end if;
  if app.core_next_contact(clock_timestamp(),s.follow_up_preferences,s.default_timezone)>clock_timestamp()+interval '1 second'
    or i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then return '{"authorized":false}';end if;
  payment:=app.zoho_reminder_payment(p_owner_id,p_workspace_id,i.id);
  if payment->>'ok' is distinct from 'true' then return '{"authorized":false}';end if;

  if i.metadata#>>'{approved_reminder_delivery,version}'='2' then
    review_result:=app.evaluate_reviewed_reminder(p_owner_id,p_workspace_id,i.id,c.id,p_snapshot,p_snapshot_hash,true);
    if review_result->>'authorized' is distinct from 'true' then return jsonb_build_object('authorized',false,'reason','needs_re_review','reviewReason',review_result->>'reason');end if;
    -- The reservation may cross the window boundary after JS preparation.
    -- Choose only an already approved artifact, and bind the durable receipt to
    -- the final selected words/form. The provider verifies this returned hash.
    body:=review_result->>'body';
    p_snapshot:=p_snapshot||jsonb_build_object('body',body,'delivery',review_result->'delivery','deliveryForm',review_result->'form');
    p_snapshot_hash:=encode(sha256(convert_to(app.reminder_canonical_json(p_snapshot),'UTF8')),'hex');
  else
    if not app.legacy_reminder_approval_matches(p_owner_id,i) then
      update public.invoices set followup_state='paused',next_follow_up_at=null,
        metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review')
        where workspace_id=p_workspace_id and id=i.id;
      return '{"authorized":false,"reason":"needs_re_review"}';
    end if;
  select * into t from app.first_party_reminder_templates where waba_id=p_snapshot#>>'{template,wabaId}'
    and name=p_snapshot#>>'{template,name}' and language=p_snapshot#>>'{template,language}' and revision=p_snapshot#>>'{template,revision}' for share;
  if t.name is null or t.language<>'en' or not t.approved or t.waba_id<>'1734116767674237'
    or (t.parameter_count=3 and (x.reminder_tone is not null or
      case when s.follow_up_preferences ? 'templateName' then (t.name is distinct from s.follow_up_preferences->>'templateName'
        and t.name is distinct from case s.follow_up_preferences->>'templateName'
          when 'cetld_invoice_update_v2' then 'cetld_invoice_update_v3'
          when 'cetld_invoice_update_btn_v2' then 'cetld_invoice_update_btn_v3'
          when 'cetld_invoice_gentle_v1' then 'cetld_invoice_gentle_v2'
          when 'cetld_invoice_gentle_btn_v1' then 'cetld_invoice_gentle_btn_v2'
          else s.follow_up_preferences->>'templateName' end)
      else t.tone<>(case when s.follow_up_preferences->>'tone'='gentle' then 'gentle' else 'professional' end)
        or t.button_variant<>coalesce((s.follow_up_preferences->>'templateButtons')::boolean,false) end))
    or (t.parameter_count=5 and (
      t.tone<>(case coalesce(x.reminder_tone,s.follow_up_preferences->>'tone','professional') when 'gentle' then 'relaxed' when 'relaxed' then 'relaxed' when 'firm' then 'firm' else 'professional' end)
      or (x.reminder_tone is null and (coalesce((s.follow_up_preferences->>'templateButtons')::boolean,false) or s.follow_up_preferences ? 'templateName'))))
    or p_snapshot#>>'{template,phoneNumberId}' !~ '^[0-9]{5,30}$'
    or p_snapshot->>'phone' not in ('+919871367051','+919818685252') or t.body is distinct from p_snapshot#>>'{template,body}' then return '{"authorized":false}';end if;
  if t.parameter_count=5 then
    if x.name ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]' then return '{"authorized":false}';end if;
    facts:=jsonb_build_array(
      coalesce(nullif(btrim(x.name,U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'),''),'there'),
      s.business_name,i.invoice_number,app.reminder_outstanding_text(i.total_amount-i.amount_paid,coalesce(i.currency,'INR')),
      to_char(i.due_date,'DD Mon YYYY'));
  else facts:=jsonb_build_array(s.business_name,i.invoice_number,x.name);end if;
  if exists(select 1 from jsonb_array_elements_text(facts) e(v) where v is null or length(btrim(v)) not between 1 and 256
    or length(v)>256 or v ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]') then return '{"authorized":false}';end if;
  if facts is distinct from p_snapshot#>'{template,parameters}' then return '{"authorized":false}';end if;
  body:=t.body;for n in 1..t.parameter_count loop body:=replace(body,'{{'||n||'}}',facts->>(n-1));end loop;
  if t.parameter_count=5 and (p_snapshot->>'defaultDraft') is distinct from
    ('Hi '||(facts->>0)||', this is '||(facts->>1)||'. Invoice '||(facts->>2)||
     ' has an outstanding balance of '||(facts->>3)||', due on '||(facts->>4)||
     '. Please arrange payment, or reply here if you have any questions.') then return '{"authorized":false}';end if;
  if body is distinct from p_snapshot->>'body'
    or body like '%{{%' or encode(sha256(convert_to(app.reminder_canonical_json(p_snapshot),'UTF8')),'hex')<>p_snapshot_hash
    then return '{"authorized":false}';end if;

  if i.metadata->'approved_reminder_delivery' is distinct from jsonb_build_object(
    'type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',facts,'body',body,'buttonVariant',t.button_variant)
    or p_snapshot->'delivery' is distinct from i.metadata->'approved_reminder_delivery'
    or i.metadata->>'approved_reminder_text' is distinct from app.normalize_reminder_punctuation(body)||E'\n\n'||app.normalize_reminder_punctuation(s.business_name) then
    update public.invoices set followup_state='paused',next_follow_up_at=null,
      metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review') where id=i.id and workspace_id=p_workspace_id;
    return '{"authorized":false,"reason":"needs_re_review"}';
  end if;

  end if;
  token:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  insert into app.first_party_reminder_dispatches(claim_id,workspace_id,owner_id,invoice_id,customer_id,phone,callback_token,snapshot,snapshot_hash,count_before,lease_until)
    values(c.id,p_workspace_id,p_owner_id,i.id,x.id,x.phone,token,p_snapshot,p_snapshot_hash,i.reminder_count,c.lease_until) on conflict do nothing;
  if not found then return '{"authorized":false}';end if;
  insert into public.whatsapp_messages(workspace_id,customer_id,invoice_id,phone,direction,audience,body,kind,status,idempotency_key,callback_token)
    values(p_workspace_id,x.id,i.id,x.phone,'outbound','customer',body,'reminder','unknown','reminder:'||c.id::text,token);
  return jsonb_build_object('authorized',true,'snapshot_hash',p_snapshot_hash,'callback_token',token)||case when review_result is null then '{}'::jsonb else jsonb_build_object('delivery',review_result->'delivery','deliveryForm',review_result->'form','windowDeadline',review_result->'windowDeadline') end;
exception when invalid_text_representation or datetime_field_overflow then return '{"authorized":false}';
end $function$
;
revoke all on function app.zoho_reminder_final(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_template_gate(p_workspace_id uuid, p_owner_id uuid, p_invoice_id uuid, p_send_now boolean, p_preview text, p_approval_text text, p_template jsonb, p_snapshot jsonb, p_apply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
 v_phone text;v_now timestamptz:=clock_timestamp();v_payment jsonb;v_template record;v_body text;v_n integer;v_parameter text;
begin
 if p_send_now is null or p_apply is null or p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
  or p_template is null or jsonb_typeof(p_template)<>'object' or p_preview is null or p_approval_text is null then
  return jsonb_build_object('ok',false,'code','INVALID');end if;
    -- Match delivery's phone -> settings -> customer -> invoice lock order.
    select c.phone into v_phone from public.customers c join public.invoices v on v.workspace_id=c.workspace_id and v.customer_id=c.id
      where v.workspace_id=p_workspace_id and v.id=p_invoice_id;
    if v_phone is null or v_phone!~'^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('ok',false,'code','missing_contact');end if;
    perform pg_advisory_xact_lock(hashtextextended(v_phone,0));
    select * into s from public.workspace_settings where workspace_id=p_workspace_id for share;
    select c.* into x from public.customers c where c.workspace_id=p_workspace_id and c.id=(select customer_id from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id) for share;
    select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id for update;
    if i.id is null or i.deleted_at is not null then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
    if s.workspace_id is null or nullif(btrim(s.business_name),'') is null then return jsonb_build_object('ok',false,'code','business_name_required');end if;
    if x.id is distinct from i.customer_id or x.phone is distinct from v_phone then return jsonb_build_object('ok',false,'code','STALE');end if;
    if not app.zoho_reminder_context_payable(i) or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable' then
      return jsonb_build_object('ok',false,'code','ineligible_invoice');end if;
    if i.metadata->'followup_exception' is not null and i.metadata->'followup_exception'<>'null'::jsonb and coalesce(i.metadata->'followup_exception'->>'resolved_at','')='' then
      return jsonb_build_object('ok',false,'code','unresolved_exception');end if;
    if exists(select 1 from public.whatsapp_global_suppressions where phone=v_phone) then return jsonb_build_object('ok',false,'code','globally_suppressed');end if;
    if exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=v_phone) then return jsonb_build_object('ok',false,'code','suppressed');end if;
    if not exists(select 1 from public.whatsapp_consents c where c.workspace_id=p_workspace_id and c.phone=v_phone and c.customer_id=x.id
      and c.revoked_at is null and c.source in ('verbal','inbound_message') and c.categories @> array['invoice_updates']::text[]) then
      return jsonb_build_object('ok',false,'code','missing_consent');end if;
    if i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then return jsonb_build_object('ok',false,'code','reminder_limit');end if;
    if p_send_now and app.core_next_contact(v_now,s.follow_up_preferences,s.default_timezone)>v_now then return jsonb_build_object('ok',false,'code','contact_hours');end if;
    if exists(select 1 from public.cetld_core_automation_delivery_claims c where c.workspace_id=p_workspace_id and c.invoice_id=i.id and c.status in ('claimed','sending','quarantined')) then
      return jsonb_build_object('ok',false,'code','delivery_in_progress');end if;
    v_payment:=app.zoho_reminder_payment(p_owner_id,p_workspace_id,i.id);
    if v_payment->>'ok' is distinct from 'true' then return jsonb_build_object('ok',false,'code',coalesce(v_payment->>'reason','payment_balance_mismatch'));end if;
    if i.automation_version::text is distinct from p_snapshot->>'invoiceVersion' or i.updated_at is distinct from (p_snapshot->>'invoiceUpdatedAt')::timestamptz
      or s.updated_at is distinct from (p_snapshot->>'settingsUpdatedAt')::timestamptz
      or jsonb_build_object('id',x.id,'name',x.name,'phone',x.phone,'reminder_tone',x.reminder_tone) is distinct from p_snapshot->'customer' then
      return jsonb_build_object('ok',false,'code','STALE');end if;
    -- The private server renders the existing catalog with existing parameter
    -- builders. Never accept a model-authored body, template or greeting here.
    select * into v_template from app.first_party_reminder_templates where waba_id='1734116767674237' and name=p_template->>'name'
      and language=p_template->>'language' and revision=p_template->>'revision' and approved;
    if not found or jsonb_typeof(p_template->'parameters') is distinct from 'array' or jsonb_array_length(p_template->'parameters')<>v_template.parameter_count then
      return jsonb_build_object('ok',false,'code','template_unavailable');end if;
    v_body:=v_template.body;
    for v_n in 1..v_template.parameter_count loop
      v_parameter:=p_template->'parameters'->>(v_n-1);
      if v_parameter is null or length(btrim(v_parameter))=0 or length(v_parameter)>256 or v_parameter ~ U&'[{}\0001-\001f\007f-\009f\2028\2029]' then
        return jsonb_build_object('ok',false,'code','template_unavailable');end if;
      v_body:=replace(v_body,'{{'||v_n::text||'}}',v_parameter);
    end loop;
    if v_body is distinct from p_preview or p_approval_text is distinct from app.normalize_reminder_punctuation(p_preview)||E'\n\n'||app.normalize_reminder_punctuation(s.business_name) then
      return jsonb_build_object('ok',false,'code','template_unavailable');end if;

 if not p_apply then return jsonb_build_object('ok',true,'requiresConfirmation',true,'invoiceNumber',i.invoice_number,'preview',p_preview,'sendNow',p_send_now);end if;
    -- Exactly the dashboard approval metadata, with now only for Send now.
    -- Existing branded/fact/preference invalidation triggers remain active.
    update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved',
      'reminder_text',p_approval_text,'approved_reminder_text',p_approval_text,'approved_preferences_updated_at',s.updated_at,
      'approved_reminder_delivery_reviewed_at',v_now,'approved_reminder_delivery',jsonb_build_object('type','template','name',p_template->>'name','language',p_template->>'language','revision',p_template->>'revision','parameters',p_template->'parameters','body',p_preview,'buttonVariant',v_template.button_variant),
      'next_follow_up_at',case when p_send_now then v_now else next_follow_up_at end),
      followup_state='approved',next_follow_up_at=case when p_send_now then v_now else next_follow_up_at end
      where workspace_id=p_workspace_id and id=i.id returning * into i;
    if i.followup_state<>'approved' or i.metadata->>'approved_reminder_text' is distinct from p_approval_text then raise exception 'approval invalidated';end if;

 return jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now);
end $function$
;
revoke all on function app.zoho_reminder_template_gate(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_owner(p_workspace_id uuid, p_owner_id uuid, p_invoice_id uuid, p_send_now boolean, p_preview text, p_approval_text text, p_template jsonb, p_snapshot jsonb, p_apply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;d jsonb:=p_template->'reviewedDelivery';i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
 deadline timestamptz;core jsonb;fallback jsonb;approval_id uuid;stamp timestamptz:=clock_timestamp();t record;
begin
 if d is null then return app.zoho_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_apply);end if;
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then return '{"ok":false,"code":"DENIED"}';end if;
 -- The old gate locks and rechecks every eligibility fact without applying an approval.
 r:=app.zoho_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_template->>'templatePreview',
 app.normalize_reminder_punctuation(p_template->>'templatePreview')||E'\n\n'||(select app.normalize_reminder_punctuation(business_name) from public.workspace_settings where workspace_id=p_workspace_id),p_template,p_snapshot,false);
 if r->>'ok' is distinct from 'true' then return r;end if;
 select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id;
 select * into s from public.workspace_settings where workspace_id=p_workspace_id;
 select * into x from public.customers where workspace_id=p_workspace_id and id=i.customer_id;
 deadline:=app.reminder_window_deadline(p_workspace_id,x.id,x.phone);stamp:=clock_timestamp();
 if d->>'version' is distinct from '2' or d->>'type' not in ('template','freeform') or d->>'tone' not in ('gentle','relaxed','firm','professional')
 or d->>'mode' is distinct from (case when p_send_now then 'immediate' else 'scheduled' end)
 or d->>'body' is distinct from p_preview or length(p_preview) not between 1 and 4000 or d ? 'approvalId' then return '{"ok":false,"code":"INVALID"}';end if;
 -- The tone is frozen to the exact template proposed at review, not business defaults at dispatch.
 select * into t from app.first_party_reminder_templates where waba_id='1734116767674237' and name=p_template->>'name' and revision=p_template->>'revision' and language=p_template->>'language' and approved;
 if not found or t.parameter_count<>5 or t.tone is distinct from (case d->>'tone' when 'gentle' then 'relaxed' else d->>'tone' end) then return '{"ok":false,"code":"template_unavailable"}';end if;
 core:=jsonb_build_object('type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',p_template->'parameters','body',p_template->'templatePreview','buttonVariant',t.button_variant);
 if app.checked_reminder_template(i,s,x,core) is null then return '{"ok":false,"code":"template_unavailable"}';end if;
 if d->>'type'='template' then
  if app.reminder_template_core(d) is distinct from core or p_approval_text is distinct from app.reminder_artifact_text(d,p_preview,s.business_name) or d->'fallback' not in ('null'::jsonb) then return '{"ok":false,"code":"INVALID"}';end if;
 else
  if not p_send_now then return '{"ok":false,"code":"scheduled_template_only"}';end if;
  if p_approval_text is distinct from app.reminder_artifact_text(d,p_preview,s.business_name) or d->>'body' ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then return '{"ok":false,"code":"INVALID"}';end if;
  if d->'fallback' is not null and d->'fallback'<>'null'::jsonb then
   fallback:=app.checked_reminder_template(i,s,x,d->'fallback');
   if fallback is null or fallback is distinct from core then return '{"ok":false,"code":"INVALID_FALLBACK"}';end if;
  end if;
  -- A deadline snapshot never grants a new window. Confirmation rechecks the current one.
  if deadline is null or deadline<=stamp or (d->>'windowExpiresAt')::timestamptz is distinct from deadline then return '{"ok":false,"code":"undeliverable_window_expired"}';end if;
 end if;
 if not p_apply then return jsonb_build_object('ok',true,'preview',p_preview,'delivery',d,'windowExpiresAt',deadline);end if;
 approval_id:=gen_random_uuid();d:=d||jsonb_build_object('approvalId',approval_id);
 insert into app.reminder_approvals(id,workspace_id,owner_id,invoice_id,approved_form,delivery,approved_text,approved_template,approved_fallback_template,window_deadline,approved_at)
 values(approval_id,p_workspace_id,p_owner_id,p_invoice_id,d->>'type',d,p_preview,case when d->>'type'='template' then core end,fallback,deadline,stamp);
 update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved','reminder_text',p_approval_text,'reminder_draft_text',p_template->>'dashboardDraft','reminder_draft_tone',d->>'tone','approved_reminder_text',p_approval_text,
 'approved_preferences_updated_at',s.updated_at,'approved_reminder_delivery_reviewed_at',stamp,'approved_reminder_delivery',d,'next_follow_up_at',case when p_send_now then stamp else next_follow_up_at end),
 followup_state='approved',next_follow_up_at=case when p_send_now then stamp else next_follow_up_at end where workspace_id=p_workspace_id and id=i.id returning * into i;
 if i.followup_state<>'approved' or i.metadata->'approved_reminder_delivery' is distinct from d then raise exception 'approval invalidated';end if;
 return jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now,'delivery',d);
end $function$
;
revoke all on function app.zoho_reminder_owner(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.zoho_reminder_receipt(p_callback_token text, p_waba_id text, p_phone_number_id text, p_phone text, p_message_id text, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d app.first_party_reminder_dispatches%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;
  next_at timestamptz; rank_old integer;rank_new integer; own_reconciled_version bigint;
begin
  if p_status is null or p_status not in ('accepted','sent','delivered','read','failed') or p_message_id is null or length(p_message_id) not between 1 and 256 then return '{"ok":false}';end if;
  select * into d from app.first_party_reminder_dispatches where callback_token=p_callback_token;
  if d.claim_id is null or d.phone is distinct from p_phone or d.snapshot#>>'{template,wabaId}' is distinct from p_waba_id or d.snapshot#>>'{template,phoneNumberId}' is distinct from p_phone_number_id then return '{"ok":false}';end if;
  perform pg_advisory_xact_lock(hashtextextended(d.phone,0));
  select * into s from public.workspace_settings where workspace_id=d.workspace_id for share;
  select * into i from public.invoices where workspace_id=d.workspace_id and id=d.invoice_id for update;
  perform 1 from public.cetld_core_automation_delivery_claims where id=d.claim_id for update;
  select * into d from app.first_party_reminder_dispatches where claim_id=d.claim_id for update;
  if d.provider_message_id is not null and d.provider_message_id<>p_message_id then return '{"ok":false}';end if;
  if exists(select 1 from app.first_party_reminder_dispatches where provider_message_id=p_message_id and claim_id<>d.claim_id) then return '{"ok":false}';end if;
  insert into app.first_party_reminder_receipt_events(callback_token,provider_message_id,status)
    values(p_callback_token,p_message_id,p_status) on conflict do nothing;
  if p_status='accepted' then
    update public.whatsapp_messages set status='accepted',provider_message_id=p_message_id,updated_at=clock_timestamp()
      where workspace_id=d.workspace_id and callback_token=p_callback_token and status in ('unknown','pending');
  else perform public.whatsapp_record_delivery_status(p_message_id,p_phone,p_status,p_callback_token);end if;
  rank_old:=case d.state when 'accepted' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  rank_new:=case p_status when 'accepted' then 1 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if rank_new=0 and rank_old>=2 then return '{"ok":true}';end if;
  -- HTTP acceptance and sent are weaker than a signed conclusive failure.
  -- Delivered/read may supersede it, retaining the complete receipt audit.
  if d.state='failed' and rank_new=1 then return '{"ok":true,"status":"failed"}';end if;
  update app.first_party_reminder_dispatches set state=case when rank_new>=rank_old then case p_status when 'sent' then 'accepted' else p_status end else state end,
    provider_message_id=p_message_id,receipt_at=coalesce(receipt_at,clock_timestamp()) where claim_id=d.claim_id;
  if rank_new=0 then
    update app.first_party_reminder_dispatches set state='failed',last_error='signed_provider_failure' where claim_id=d.claim_id;
    update public.cetld_core_automation_delivery_claims set status='failed',provider_message_id=p_message_id,last_error='signed_provider_failure' where id=d.claim_id;
    update public.cetld_core_automation_messages set status='failed',provider_message_id=p_message_id where workspace_id=d.workspace_id and payload->>'claimId'=d.claim_id::text;
    -- Pause only the exact invoice state produced by this dispatch. Never undo
    -- a newer owner edit, payment, STOP, settings edit or review. Accepted counts
    -- remain attempts; no subtraction or retry is safe after provider acceptance.
    if d.state<>'failed' and i.deleted_at is null
      and i.automation_version=coalesce(d.reconciled_invoice_version,(d.snapshot->>'invoiceVersion')::bigint)
      and s.updated_at=(d.snapshot->>'preferencesUpdatedAt')::timestamptz
      and i.followup_state in ('approved','active','scheduled') and app.zoho_reminder_context_payable(i)
      and i.amount_paid<i.total_amount and i.metadata->>'invoice_direction'='receivable' then
      update public.invoices set followup_state='paused',next_follow_up_at=null,
        metadata=metadata-'approved_reminder_text'-'approved_preferences_updated_at'
        where workspace_id=d.workspace_id and id=d.invoice_id;
    end if;
    return '{"ok":true,"status":"failed"}';
  end if;
  update public.cetld_core_automation_delivery_claims set status='sent',provider_message_id=p_message_id,last_error=null where id=d.claim_id;
  update public.cetld_core_automation_messages set status='sent',provider_message_id=p_message_id where workspace_id=d.workspace_id and payload->>'claimId'=d.claim_id::text;
  if not d.counted and i.deleted_at is null then
    -- Already committed normal engine receipt/count wins. A recovered receipt
    -- never overwrites payment/pause/STOP/changed preferences or edited facts.
    if i.reminder_count<=d.count_before then
      next_at:=i.next_follow_up_at;
      if i.metadata#>>'{approved_reminder_delivery,version}'='2' and i.metadata#>>'{approved_reminder_delivery,mode}'='immediate' then next_at:=null;end if;
      if i.automation_version=(d.snapshot->>'invoiceVersion')::bigint and i.followup_state in ('approved','active','scheduled')
        and not (coalesce(i.metadata#>>'{approved_reminder_delivery,version}','')='2' and coalesce(i.metadata#>>'{approved_reminder_delivery,mode}','')='immediate')
        and i.amount_paid<i.total_amount and app.zoho_reminder_context_payable(i) and i.metadata->>'invoice_direction'='receivable'
        and s.updated_at=(d.snapshot->>'preferencesUpdatedAt')::timestamptz
        and not exists(select 1 from public.whatsapp_global_suppressions where phone=d.phone)
        and not exists(select 1 from public.whatsapp_suppressions where workspace_id=d.workspace_id and phone=d.phone) then
        next_at:=app.core_next_contact(clock_timestamp()+make_interval(days=>coalesce((s.follow_up_preferences->>'cadenceDays')::integer,3)),s.follow_up_preferences,s.default_timezone);
        if i.reminder_count+1>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then next_at:=null;end if;
      end if;
      update public.invoices set reminder_count=reminder_count+1,last_follow_up_at=greatest(coalesce(last_follow_up_at,d.reserved_at),d.reserved_at),
        next_follow_up_at=next_at,followup_state=case when next_at is null and followup_state in ('approved','active','scheduled') then 'paused' else followup_state end
        where workspace_id=d.workspace_id and id=d.invoice_id returning automation_version into own_reconciled_version;
    end if;
    update app.first_party_reminder_dispatches set counted=true,reconciled_invoice_version=own_reconciled_version where claim_id=d.claim_id;
  end if;
  return '{"ok":true}';
end $function$
;
revoke all on function app.zoho_reminder_receipt(text,text,text,text,text,text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.cetld_zoho_capture_completion_protocol(p_owner_id uuid, p_workspace_id uuid, p_invoice_id uuid, p_action text, p_operation_id uuid DEFAULT NULL::uuid, p_expected_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_expected_version bigint DEFAULT NULL::bigint, p_expected_epoch uuid DEFAULT NULL::uuid, p_external_id text DEFAULT NULL::text, p_outcome text DEFAULT NULL::text, p_capture_nonce uuid DEFAULT NULL::uuid, p_customer_external_id text DEFAULT NULL::text, p_currency text DEFAULT NULL::text, p_total numeric DEFAULT NULL::numeric, p_paid numeric DEFAULT NULL::numeric, p_balance numeric DEFAULT NULL::numeric, p_status text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_due_date date DEFAULT NULL::date, p_reference text DEFAULT NULL::text, p_remote_number text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare i public.invoices;cust public.customers;c public.cetld_accounting_connections;e app.accounting_connection_epochs;
 o app.zoho_capture_completion;valid boolean;
begin
 if p_action is null or p_action not in ('reserve','start','complete','abort') then raise exception 'CAPTURE_PROTOCOL_INPUT';end if;
 if p_action<>'complete' and (p_capture_nonce is not null or p_customer_external_id is not null or p_currency is not null
  or p_total is not null or p_paid is not null or p_balance is not null or p_status is not null or p_date is not null or p_due_date is not null
  or p_reference is not null or p_remote_number is not null) then raise exception 'CAPTURE_PROTOCOL_INPUT';end if;
 -- Customer -> invoice -> connection -> epoch -> protocol. Customer tone
 -- invalidation and reviewed approval already use this order.
 select x.* into cust from public.customers x join public.invoices v on v.customer_id=x.id and v.workspace_id=x.workspace_id
 join public.workspaces w on w.id=v.workspace_id where v.id=p_invoice_id and v.workspace_id=p_workspace_id and w.owner_id=p_owner_id for update of x;
 select v.* into i from public.invoices v join public.workspaces w on w.id=v.workspace_id
 where v.id=p_invoice_id and v.workspace_id=p_workspace_id and w.owner_id=p_owner_id for update of v;
 if i.id is null or cust.id is distinct from i.customer_id then raise exception 'CAPTURE_PROTOCOL_SCOPE';end if;
 select * into c from public.cetld_accounting_connections where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into e from app.accounting_connection_epochs where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into o from app.zoho_capture_completion where invoice_id=i.id and owner_id=p_owner_id and workspace_id=p_workspace_id for update;
 if o.invoice_id is null then return jsonb_build_object('state','not_admitted','originCaptured',false);end if;
 if p_action='reserve' then
  if o.state<>'eligible' then return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  if p_operation_id is not null or p_external_id is not null or p_outcome is not null then raise exception 'CAPTURE_PROTOCOL_INPUT';end if;
  if i.updated_at is distinct from p_expected_updated_at or i.automation_version is distinct from p_expected_version then raise exception 'CAPTURE_PROTOCOL_VERSION';end if;
  if cust.id is null or i.deleted_at is not null or app.invoice_has_external_ledger(i) or i.metadata ? 'test_invoice'
   or i.metadata->>'invoice_direction' is distinct from 'receivable' or i.status not in ('draft','sent','overdue') or i.amount_paid<>0
   or exists(select 1 from app.zoho_export_operations where invoice_id=i.id)
   or i.metadata ? 'bookkeeping_sync_attempted_at' or i.metadata ? 'bookkeeping_sync_attempts' then
   update app.zoho_capture_completion set state='excluded',reason='prior_or_ineligible' where invoice_id=i.id;
   return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  if c.owner_id is null or c.status<>'connected' or e.epoch_id is null or not e.present or e.epoch_id is distinct from p_expected_epoch
   or nullif(c.provider_account_id,'') is null or nullif(c.region,'') is null then
   update app.zoho_capture_completion set state='excluded',reason='epoch_unavailable' where invoice_id=i.id;
   return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  insert into app.zoho_capture_write_context values(txid_current(),i.id);
  update public.invoices set metadata=metadata||jsonb_build_object('bookkeeping_sync_status','pending','bookkeeping_sync_attempts',0,
   'bookkeeping_sync_attempted_at',clock_timestamp(),'bookkeeping_sync_next_at',clock_timestamp()+interval '2 minutes')
   where id=i.id returning * into i;
  delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
  update app.zoho_capture_completion set state='reserved',operation_id=gen_random_uuid(),epoch_id=e.epoch_id,
   attempted_account_id=c.provider_account_id,attempted_region=c.region,deadline=clock_timestamp()+interval '2 minutes',
   expected_customer_id=(select external_customer_id from app.zoho_customer_origins where customer_id=cust.id and workspace_id=p_workspace_id and account_id=c.provider_account_id and region=c.region),
   invoice_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),
   customer_hash=encode(sha256(convert_to(to_jsonb(cust)::text,'UTF8')),'hex') where invoice_id=i.id returning * into o;
  return jsonb_build_object('state','reserved','operationId',o.operation_id,'invoice',to_jsonb(i)||jsonb_build_object('total_amount',i.total_amount::text,'amount_paid',i.amount_paid::text),
   'customer',jsonb_build_object('id',cust.id,'name',cust.name,'email',cust.email,'phone',cust.phone,'expectedExternalCustomerId',o.expected_customer_id,
    'capturePermitted',(cust.external_provider is null and cust.external_customer_id is null or o.expected_customer_id is not null)
     and not exists(select 1 from app.zoho_invoice_origins where customer_id=cust.id and workspace_id=p_workspace_id
      and (account_id,region) is distinct from (o.attempted_account_id,o.attempted_region))),'originCaptured',false);
 end if;
 if p_operation_id is null or o.operation_id is distinct from p_operation_id then raise exception 'CAPTURE_PROTOCOL_UNKNOWN';end if;
 -- Terminal replay is read-only and does not consult today's connection as an
 -- origin assertion. It only recovers an unchanged, already-committed result.
 if p_action='complete' and o.state in ('completed_unverified','captured') then
  if o.result_external_id=p_external_id and o.outcome=p_outcome and i.external_provider='zoho_books'
   and i.external_invoice_id=o.result_external_id and i.deleted_at is null
   and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.result_hash then
   return jsonb_build_object('state',o.state,'invoice',to_jsonb(i),'originCaptured',o.state='captured' and exists(select 1 from app.zoho_invoice_origins where invoice_id=i.id));end if;
  raise exception 'CAPTURE_PROTOCOL_REPLAY_CONFLICT';
 end if;
 valid:=o.state in ('reserved','started') and clock_timestamp()<=o.deadline and i.deleted_at is null
  and not app.invoice_has_external_ledger(i) and c.status='connected' and e.present and e.epoch_id=o.epoch_id
  and c.provider_account_id=o.attempted_account_id and c.region=o.attempted_region
  and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.invoice_hash
  and encode(sha256(convert_to(to_jsonb(cust)::text,'UTF8')),'hex')=o.customer_hash;
 if p_action='abort' or valid is distinct from true then
  if o.state in ('reserved','started') then
   if p_action='abort' and valid is true then
    insert into app.zoho_capture_write_context values(txid_current(),i.id);
    update public.invoices set sync_status='failed',last_sync_error='ACCOUNTING_EXPORT_UNVERIFIED',
     metadata=metadata||jsonb_build_object('bookkeeping_sync_status','failed','bookkeeping_sync_error','ACCOUNTING_EXPORT_UNVERIFIED',
      'bookkeeping_sync_next_at',clock_timestamp()+interval '5 minutes') where id=i.id returning * into i;
    delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
   end if;
   update app.zoho_capture_completion set state='excluded',reason=case when p_action='abort' then 'unknown' else 'changed_or_expired' end,
    outcome='unknown_unverified' where invoice_id=i.id;
  end if;
  return jsonb_build_object('state','excluded','invoice',to_jsonb(i),'originCaptured',false);
 end if;
 if p_action='start' then
  if o.state<>'reserved' or p_external_id is not null or p_outcome is not null then raise exception 'CAPTURE_PROTOCOL_NOT_RESERVED';end if;
  insert into app.zoho_capture_write_context values(txid_current(),i.id);
  update public.invoices set metadata=metadata||jsonb_build_object('bookkeeping_sync_attempts',1) where id=i.id returning * into i;
  delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
  update app.zoho_capture_completion set state='started',capture_nonce=gen_random_uuid(),invoice_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex') where invoice_id=i.id returning * into o;
  return jsonb_build_object('state','started','captureNonce',o.capture_nonce,'originCaptured',false);
 end if;
 if o.state<>'started' or p_external_id is null or length(p_external_id) not between 1 and 100 or p_external_id ~ '[[:cntrl:]]'
  or p_outcome is null or p_outcome not in ('created_unverified','duplicate_unverified','captured') then raise exception 'CAPTURE_PROTOCOL_RESULT';end if;
 -- Only the trusted adapter capability path supplies this nonce and complete
 -- normalized POST facts. SQL independently checks the durable operation and
 -- saved facts; owner/metadata/old-worker JSON cannot grant origin.
 if p_outcome='captured' and (p_capture_nonce is null or p_capture_nonce is distinct from o.capture_nonce
  or o.attempted_account_id !~ '^[0-9]{1,40}$' or o.attempted_region not in ('com','eu','in','com.au','jp','ca','com.cn','sa')
  or p_external_id !~ '^[0-9]{1,40}$' or p_customer_external_id is null or p_customer_external_id !~ '^[0-9]{1,40}$'
  or p_currency not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF') or p_currency is distinct from i.currency or p_total is distinct from i.total_amount or p_paid is distinct from 0::numeric
  or p_balance is distinct from i.total_amount or p_status is distinct from i.status::text or p_status not in ('draft','sent','overdue')
  or p_date is distinct from i.issue_date or p_due_date is distinct from i.due_date
  or p_reference is distinct from 'cetld:'||i.id::text or p_remote_number is distinct from i.invoice_number
  or nullif(btrim(p_remote_number),'') is null or length(p_remote_number)>100 or p_remote_number ~ '[[:cntrl:]]'
  or (o.expected_customer_id is null and (cust.external_provider is not null or cust.external_customer_id is not null))
  or (o.expected_customer_id is not null and (p_customer_external_id is distinct from o.expected_customer_id
   or cust.external_provider is not null and cust.external_provider<>'zoho_books'
   or cust.external_customer_id is not null and cust.external_customer_id<>o.expected_customer_id))
  or exists(select 1 from app.zoho_invoice_origins where customer_id=i.customer_id and workspace_id=i.workspace_id
   and (account_id,region) is distinct from (o.attempted_account_id,o.attempted_region))) then raise exception 'CAPTURE_RECEIPT_INVALID';end if;
 insert into app.zoho_capture_write_context values(txid_current(),i.id);
 if p_outcome='captured' then
  -- Customer FOR UPDATE serializes same-customer completion. Recheck NOW,
  -- not the reserve-time NULL snapshot; reverse uniqueness serializes distinct
  -- local customers attempting the same remote identity. Any conflict rolls
  -- back mapping, origin and invoice linkage together.
  if exists(select 1 from app.zoho_customer_origins m where m.workspace_id=i.workspace_id
   and m.provider='zoho_books' and m.account_id=o.attempted_account_id and m.region=o.attempted_region
   and ((m.customer_id=i.customer_id and m.external_customer_id<>p_customer_external_id)
    or (m.external_customer_id=p_customer_external_id and m.customer_id<>i.customer_id))) then
   raise exception 'CAPTURE_CUSTOMER_IDENTITY_CONFLICT';end if;
  if not exists(select 1 from app.zoho_customer_origins m where m.workspace_id=i.workspace_id
   and m.provider='zoho_books' and m.account_id=o.attempted_account_id and m.region=o.attempted_region and m.customer_id=i.customer_id) then
   insert into app.zoho_customer_origins values(p_owner_id,p_workspace_id,'zoho_books',o.attempted_account_id,o.attempted_region,
    i.customer_id,p_customer_external_id,o.operation_id);
  end if;
  insert into app.zoho_invoice_origins(invoice_id,owner_id,workspace_id,provider,account_id,region,customer_id,external_customer_id,
   external_invoice_id,operation_id,currency,total,paid,balance,provider_status,invoice_date,due_date,reference,remote_number)
  values(i.id,p_owner_id,p_workspace_id,'zoho_books',o.attempted_account_id,o.attempted_region,i.customer_id,p_customer_external_id,
   p_external_id,o.operation_id,p_currency,p_total,p_paid,p_balance,p_status,p_date,p_due_date,p_reference,p_remote_number);
 end if;
 update public.invoices set external_provider='zoho_books',external_invoice_id=p_external_id,sync_status='synced',last_sync_error=null,last_synced_at=clock_timestamp(),
  metadata=metadata||jsonb_build_object('bookkeeping_provider','zoho_books','bookkeeping_record_id',p_external_id,'bookkeeping_sync_status','synced',
   'bookkeeping_sync_error',null,'bookkeeping_sync_http_status',null,'bookkeeping_sync_provider_code',null,'bookkeeping_sync_provider_message',null,
   'bookkeeping_sync_provider_operation',null,'bookkeeping_sync_next_at',null,'bookkeeping_synced_at',clock_timestamp())
 where id=i.id returning * into i;
 delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
 update app.zoho_capture_completion set state=case when p_outcome='captured' then 'captured' else 'completed_unverified' end,result_external_id=p_external_id,outcome=p_outcome,
  result_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),capture_nonce=null where invoice_id=i.id;
 return jsonb_build_object('state',case when p_outcome='captured' then 'captured' else 'completed_unverified' end,'invoice',to_jsonb(i),'originCaptured',p_outcome='captured');
end; $function$
;

CREATE OR REPLACE FUNCTION app.zoho_bound_claim_protocol(p_owner uuid, p_workspace uuid, p_invoice uuid, p_action text, p_claim uuid DEFAULT NULL::uuid, p_attempt uuid DEFAULT NULL::uuid, p_nonce uuid DEFAULT NULL::uuid, p_permit text DEFAULT NULL::text, p_facts jsonb DEFAULT NULL::jsonb, p_message_id text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
declare c app.zoho_bound_claims; f jsonb;b app.zoho_invoice_origins; i public.invoices;v_phone text;permit text;target uuid;valid boolean;
begin
 if p_owner is null or p_workspace is null or p_invoice is null or p_action is null
  or p_action not in ('claim','challenge','check','reserve','begin_post','receipt','quarantine','recover') then raise exception 'BOUND_CLAIM_INPUT';end if;
 if p_facts is not null and octet_length(p_facts::text)>8192 then raise exception 'BOUND_CLAIM_ENVELOPE';end if;
 if p_action<>'reserve' and p_facts is not null or p_action<>'receipt' and (p_message_id is not null or p_status is not null)
  or p_action not in ('begin_post','receipt') and p_permit is not null
  or p_action not in ('check','reserve') and p_nonce is not null
  or p_action not in ('reserve','begin_post','receipt') and p_attempt is not null then raise exception 'BOUND_CLAIM_ENVELOPE';end if;
 if p_action='recover' then
  select * into c from app.zoho_bound_claims where id=p_claim and owner_id=p_owner and workspace_id=p_workspace and invoice_id=p_invoice;
  if c.id is null then return null;end if;
  return jsonb_build_object('claimId',c.id,'attemptId',c.attempt_id,'state',c.state,'deliveryAuthority',false);
 end if;
 -- Phone/settings prefix follows STOP; customer precedes invoice as in review
 -- and capture. Connection, epoch and private claim follow. No locks span HTTP.
 select x.phone into v_phone from public.invoices v join public.customers x on x.id=v.customer_id and x.workspace_id=v.workspace_id
  where v.id=p_invoice and v.workspace_id=p_workspace;
 if v_phone is not null then perform pg_advisory_xact_lock(hashtextextended(v_phone,0));end if;
 perform 1 from public.workspace_settings where workspace_id=p_workspace for share;
 perform 1 from public.customers where workspace_id=p_workspace and id=(select customer_id from public.invoices where id=p_invoice and workspace_id=p_workspace) for share;
 select * into i from public.invoices where id=p_invoice and workspace_id=p_workspace for update;
 if not exists(select 1 from public.customers where id=i.customer_id and workspace_id=p_workspace and customers.phone=v_phone) then raise exception 'BOUND_CLAIM_SCOPE';end if;
 perform 1 from public.cetld_accounting_connections where owner_id=p_owner and workspace_id=p_workspace and provider='zoho_books' for update;
 perform 1 from app.accounting_connection_epochs where owner_id=p_owner and workspace_id=p_workspace and provider='zoho_books' for update;
 f:=app.zoho_bound_claim_frame(p_owner,p_workspace,p_invoice);
 if p_action='claim' then
  if p_claim is not null or p_attempt is not null or p_nonce is not null or f is null then return null;end if;
  if exists(select 1 from app.zoho_bound_claims where workspace_id=p_workspace and invoice_id=p_invoice
   and state in ('claimed','challenged','reserved','posting','quarantined'))
   or exists(select 1 from public.cetld_core_automation_delivery_claims where workspace_id=p_workspace and invoice_id=p_invoice
    and status in ('claimed','sending','quarantined')) then return null;end if;
  select * into b from app.zoho_invoice_origins where invoice_id=p_invoice and owner_id=p_owner and workspace_id=p_workspace;
  target:=gen_random_uuid();insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),target);
  insert into app.zoho_bound_claims(id,owner_id,workspace_id,invoice_id,origin_operation_id,customer_id,account_id,region,external_invoice_id,
   external_customer_id,epoch_id,phone,invoice_version,scheduled_for,frame,state,expires_at)
   values(target,p_owner,p_workspace,p_invoice,b.operation_id,b.customer_id,b.account_id,b.region,b.external_invoice_id,b.external_customer_id,
    (f#>>'{origin,epochId}')::uuid,v_phone,i.automation_version,i.next_follow_up_at,f,'claimed',clock_timestamp()+interval '2 minutes') on conflict do nothing returning * into c;
  delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=target;
  if c.id is null then return null;end if;
  return jsonb_build_object('claimId',c.id,'state',c.state,'deliveryAuthority',false);
 end if;
 select * into c from app.zoho_bound_claims where id=p_claim and owner_id=p_owner and workspace_id=p_workspace and invoice_id=p_invoice for update;
 if c.id is null then raise exception 'BOUND_CLAIM_SCOPE';end if;
 valid:=f is not null and f=c.frame and clock_timestamp()<c.expires_at;
 insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),c.id);
 if p_action='quarantine' then
  update app.zoho_bound_claims set state=case when state in ('accepted','failed','cancelled') then state else 'quarantined' end where id=c.id;
 elsif p_action='challenge' then
  if not valid or c.state<>'claimed' then raise exception 'BOUND_CLAIM_STALE';end if;
  update app.zoho_bound_claims set state='challenged',read_nonce=gen_random_uuid(),read_deadline=clock_timestamp()+interval '5 seconds' where id=c.id returning * into c;
 elsif p_action='check' then
  if not valid or c.state<>'challenged' or p_nonce is distinct from c.read_nonce or c.read_deadline<=clock_timestamp() then raise exception 'BOUND_CLAIM_STALE';end if;
 elsif p_action='reserve' then
  if not valid or c.state<>'challenged' or p_nonce is distinct from c.read_nonce or c.read_deadline<=clock_timestamp()
   or p_attempt is null or p_facts is null or jsonb_typeof(p_facts)<>'object' then raise exception 'BOUND_CLAIM_EVIDENCE';end if;
  if p_facts is distinct from ((c.frame->'origin')-array['fingerprint','epochId','apiDomain','accountsDomain','reminderAuthority','workspaceId','invoiceId']||jsonb_build_object('creditsApplied','0','writeOff','0')) then
   raise exception 'BOUND_CLAIM_FACTS';end if;
  permit:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  update app.zoho_bound_claims set state='reserved',attempt_id=p_attempt,read_nonce=null,
   permit_hash=encode(sha256(convert_to(permit,'UTF8')),'hex'),permit_deadline=least(c.read_deadline,clock_timestamp()+interval '2 seconds') where id=c.id returning * into c;
 elsif p_action='begin_post' then
  if not valid or c.state<>'reserved' or p_attempt is distinct from c.attempt_id or c.permit_deadline<=clock_timestamp()
   or p_permit is null or length(p_permit)<>64 or encode(sha256(convert_to(p_permit,'UTF8')),'hex') is distinct from c.permit_hash then raise exception 'BOUND_CLAIM_PERMIT';end if;
  update app.zoho_bound_claims set state='posting',posting_started_at=clock_timestamp() where id=c.id;
 elsif p_action='receipt' then
  if c.posting_started_at is null or c.state not in ('posting','quarantined','accepted','failed') or p_attempt is distinct from c.attempt_id
   or p_permit is null or length(p_permit)<>64 or encode(sha256(convert_to(p_permit,'UTF8')),'hex') is distinct from c.permit_hash
   or p_message_id is null or length(p_message_id) not between 1 and 256 or p_message_id~'[[:cntrl:]]'
   or p_status is null or p_status not in ('accepted','sent','delivered','read','failed')
   or c.provider_message_id is not null and c.provider_message_id<>p_message_id then raise exception 'BOUND_CLAIM_RECEIPT';end if;
  insert into app.zoho_bound_claim_receipts(claim_id,attempt_id,provider_message_id,status) values(c.id,p_attempt,p_message_id,p_status) on conflict do nothing;
  -- Audit only: never count/schedule/send, including callbacks after STOP/switch.
  update app.zoho_bound_claims set provider_message_id=p_message_id,
   state=case when p_status='failed' and receipt_rank<2 then 'failed'
    when state='failed' and p_status in ('accepted','sent') then state else 'accepted' end,
   receipt_rank=greatest(receipt_rank,case p_status when 'read' then 3 when 'delivered' then 2 when 'accepted' then 1 when 'sent' then 1 else 0 end) where id=c.id;
 end if;
 delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=c.id;
 select * into c from app.zoho_bound_claims where id=c.id;
 return jsonb_build_object('claimId',c.id,'attemptId',c.attempt_id,'state',c.state,'deliveryAuthority',false)
  ||case when p_action in ('challenge','check') then jsonb_build_object('context',c.frame->'origin','nonce',c.read_nonce) else '{}'::jsonb end
  ||case when p_action='reserve' then jsonb_build_object('permit',permit) else '{}'::jsonb end;
exception when others then
 delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=coalesce(c.id,target);raise;
end $function$
;

CREATE OR REPLACE FUNCTION app.invalidate_zoho_bound_claims()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; r record;
begin
 if tg_op='UPDATE' and new is not distinct from old then return new;end if;
 if tg_table_name='accounting_connection_epochs' and tg_op='UPDATE' then
  if (new.epoch_id,new.present) is not distinct from (old.epoch_id,old.present) then return new;end if;
 end if;
 if tg_op='DELETE' then d:=to_jsonb(old);else d:=to_jsonb(new);end if;
 for r in select id,state from app.zoho_bound_claims c where state in ('claimed','challenged','reserved','posting') and
  case tg_table_name
   when 'invoices' then c.invoice_id=(d->>'id')::uuid
   when 'customers' then c.customer_id=(d->>'id')::uuid
   when 'workspace_settings' then c.workspace_id=(d->>'workspace_id')::uuid
   when 'workspaces' then c.workspace_id=(d->>'id')::uuid
   when 'workspace_members' then c.workspace_id=(d->>'workspace_id')::uuid and c.owner_id=(d->>'user_id')::uuid
   when 'whatsapp_global_suppressions' then c.phone=d->>'phone'
   when 'whatsapp_suppressions' then c.workspace_id=(d->>'workspace_id')::uuid and c.phone=d->>'phone'
   when 'whatsapp_consents' then c.workspace_id=(d->>'workspace_id')::uuid and (c.phone=d->>'phone' or c.customer_id=(d->>'customer_id')::uuid)
   when 'accounting_connection_epochs' then c.workspace_id=(d->>'workspace_id')::uuid and c.owner_id=(d->>'owner_id')::uuid and d->>'provider'='zoho_books'
   else false end for update
 loop
  insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),r.id);
  update app.zoho_bound_claims set state=case when r.state='posting' then 'quarantined' else 'cancelled' end,read_nonce=null where id=r.id;
  delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=r.id;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $function$
;
create trigger zoho_claim_owner_membership_changed after update or delete on public.workspace_members for each row execute function app.invalidate_zoho_bound_claims();

-- A public core row cannot be rewritten into a grant after it is privately bound.
create function app.guard_zoho_reminder_core() returns trigger
language plpgsql security definer set search_path='' as $$
declare b app.zoho_reminder_core_bindings;
begin
 select * into b from app.zoho_reminder_core_bindings where core_claim_id=old.id;
 if b.core_claim_id is null then if tg_op='DELETE' then return old;end if;return new;end if;
 if tg_op='DELETE' or (new.id,new.workspace_id,new.invoice_id,new.scheduled_for,new.invoice_version,new.preferences_updated_at,new.attempts,new.lease_until)
  is distinct from (old.id,old.workspace_id,old.invoice_id,old.scheduled_for,old.invoice_version,old.preferences_updated_at,old.attempts,old.lease_until)
  or (not (new.status in ('cancelled','quarantined') and new.delivery_token is not distinct from old.delivery_token and new.provider_message_id is not distinct from old.provider_message_id) and not exists(select 1 from app.zoho_reminder_transaction_context t where backend_pid=pg_backend_pid() and transaction_id=txid_current()
   and invoice_id=old.invoice_id and journal_id=b.journal_id and stage in ('authorize','receipt','failure'))) then
  raise exception 'ZOHO_CORE_CLAIM_PROTECTED' using errcode='42501';end if;
 return new;
end $$;
revoke all on function app.guard_zoho_reminder_core() from public,anon,authenticated,service_role;
create trigger zoho_reminder_core_guard before update or delete on public.cetld_core_automation_delivery_claims for each row execute function app.guard_zoho_reminder_core();

create function public.cetld_zoho_bound_reminder(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,p_action text,
 p_claim_id uuid default null,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare b app.zoho_reminder_core_bindings;j app.zoho_bound_claims;i public.invoices;target_phone text;r jsonb;core record;f jsonb;keys text[];
begin
 if auth.role() is distinct from 'service_role' then raise insufficient_privilege;end if;
 if p_action is null or p_action not in ('eligible','claim','challenge','check','reserve','payment','authorize','final','failed','recover')
  or p_owner_id is null or p_workspace_id is null or p_invoice_id is null
  or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>40000 then raise exception 'ZOHO_BRIDGE_INPUT';end if;
 keys:=case p_action when 'check' then array['nonce'] when 'reserve' then array['nonce','attempt','facts']
  when 'authorize' then array['preferencesVersion'] when 'final' then array['snapshot','hash','attempt','permit']
  when 'failed' then array['unknown','token','error'] else array[]::text[] end;
 if exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(keys)) then raise exception 'ZOHO_BRIDGE_ENVELOPE';end if;
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then raise exception 'ZOHO_BRIDGE_SCOPE';end if;
 if p_action='eligible' then
  if p_claim_id is not null or public.cetld_zoho_original_bound_read_context(p_owner_id,p_workspace_id,p_invoice_id) is null then return '{"ok":false}';end if;
  return '{"ok":true,"deliveryAuthority":false}';
 end if;
 if p_action='recover' then
  select m.* into b from app.zoho_reminder_core_bindings m join app.zoho_bound_claims c on c.id=m.journal_id
   where m.core_claim_id=p_claim_id and c.owner_id=p_owner_id and c.workspace_id=p_workspace_id and c.invoice_id=p_invoice_id;
  return app.zoho_bound_claim_protocol(p_owner_id,p_workspace_id,p_invoice_id,'recover',b.journal_id);
 end if;
 -- Shared order: phone -> settings -> customer -> invoice -> connection -> epoch
 -- -> core -> private journal. No transaction spans provider HTTP.
 select x.phone into target_phone from public.invoices v join public.customers x on x.id=v.customer_id and x.workspace_id=v.workspace_id
  where v.id=p_invoice_id and v.workspace_id=p_workspace_id;
 if target_phone is null then raise exception 'ZOHO_BRIDGE_SCOPE';end if;
 perform pg_advisory_xact_lock(hashtextextended(target_phone,0));
 perform 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_owner_id and role='owner' for share;
 if not found then raise exception 'ZOHO_BRIDGE_SCOPE';end if;
 perform 1 from public.workspace_settings where workspace_id=p_workspace_id for share;
 perform 1 from public.customers where workspace_id=p_workspace_id and id=(select customer_id from public.invoices where id=p_invoice_id and workspace_id=p_workspace_id) for share;
 select * into i from public.invoices where id=p_invoice_id and workspace_id=p_workspace_id for update;
 if not exists(select 1 from public.customers x where x.id=i.customer_id and x.workspace_id=p_workspace_id and x.phone=target_phone) then raise exception 'ZOHO_BRIDGE_SCOPE';end if;
 perform 1 from public.cetld_accounting_connections where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 perform 1 from app.accounting_connection_epochs where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 if p_action='claim' then
  if p_claim_id is not null then raise exception 'ZOHO_BRIDGE_INPUT';end if;
  -- Initial supported form is the existing reviewed template; no free-form,
  -- fallback, test or generic transport is admitted by this bridge.
  if i.metadata#>>'{approved_reminder_delivery,type}' is distinct from 'template'
   or i.metadata ? 'test_invoice' then return '{"ok":false}';end if;
  if i.metadata#>>'{approved_reminder_delivery,version}' is not null
   or not app.legacy_reminder_approval_matches(p_owner_id,i) then return '{"ok":false}';end if;
  r:=app.zoho_bound_claim_protocol(p_owner_id,p_workspace_id,p_invoice_id,'claim');
  if r->>'state' is distinct from 'claimed' then return '{"ok":false}';end if;
  insert into app.zoho_reminder_transaction_context values(pg_backend_pid(),txid_current(),i.id,p_owner_id,'claim',(r->>'claimId')::uuid);
  select * into core from app.zoho_reminder_claim(p_owner_id,p_workspace_id,clock_timestamp(),1,p_invoice_id);
  if core.claim_id is null then raise exception 'ZOHO_BRIDGE_CLAIM';end if;
  insert into app.zoho_reminder_core_bindings(core_claim_id,journal_id) values(core.claim_id,(r->>'claimId')::uuid);
  delete from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=i.id;
  return jsonb_build_object('ok',true,'claimId',core.claim_id,'invoiceId',core.invoice_id,'invoiceVersion',core.invoice_version,'deliveryAuthority',false);
 end if;
 perform 1 from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id and invoice_id=p_invoice_id for update;
 select * into b from app.zoho_reminder_core_bindings where core_claim_id=p_claim_id;
 select * into j from app.zoho_bound_claims where id=b.journal_id and owner_id=p_owner_id and workspace_id=p_workspace_id and invoice_id=p_invoice_id for update;
 if j.id is null then raise exception 'ZOHO_BRIDGE_SCOPE';end if;
 if p_action in ('challenge','check','reserve') then
  r:=app.zoho_bound_claim_protocol(p_owner_id,p_workspace_id,p_invoice_id,p_action,j.id,(p_payload->>'attempt')::uuid,
   (p_payload->>'nonce')::uuid,null,p_payload->'facts');
 elsif p_action in ('payment','authorize','final') then
  f:=app.zoho_bound_claim_frame(p_owner_id,p_workspace_id,p_invoice_id);
  if f is null or f is distinct from j.frame or j.expires_at<=clock_timestamp() or j.state not in ('claimed','challenged','reserved') then raise exception 'ZOHO_BRIDGE_STALE';end if;
  insert into app.zoho_reminder_transaction_context values(pg_backend_pid(),txid_current(),i.id,p_owner_id,p_action,j.id);
  if p_action='payment' then r:=app.zoho_reminder_payment(p_owner_id,p_workspace_id,p_invoice_id);
  elsif p_action='authorize' then
   select to_jsonb(a) into r from app.zoho_reminder_authorize(p_claim_id,p_owner_id,p_workspace_id,(p_payload->>'preferencesVersion')::timestamptz) a;
  else
   if p_payload#>>'{snapshot,invoiceId}' is distinct from p_invoice_id::text
    or p_payload#>>'{snapshot,customerId}' is distinct from j.customer_id::text
    or p_payload#>>'{snapshot,phone}' is distinct from j.phone
    or p_payload#>'{snapshot,delivery}' is distinct from app.reminder_template_core(i.metadata->'approved_reminder_delivery')
    or coalesce(p_payload#>>'{snapshot,deliveryForm}','template')<>'template'
    or exists(select 1 from jsonb_object_keys(p_payload->'snapshot') k where k not in
     ('invoiceId','customerId','phone','body','invoiceVersion','invoiceUpdatedAt','preferencesUpdatedAt','delivery','deliveryForm','consentId','consentCreatedAt','template','defaultDraft')) then raise exception 'ZOHO_BRIDGE_SNAPSHOT';end if;
   -- Consume and validate final policy in ONE transaction. Any refusal rolls
   -- back consumption, public dispatch/message reservation and private context.
   r:=app.zoho_bound_claim_protocol(p_owner_id,p_workspace_id,p_invoice_id,'begin_post',j.id,(p_payload->>'attempt')::uuid,null,p_payload->>'permit');
   if r->>'state' is distinct from 'posting' then raise exception 'ZOHO_BRIDGE_PERMIT';end if;
   r:=app.zoho_reminder_final(p_owner_id,p_workspace_id,p_claim_id,p_payload->'snapshot',p_payload->>'hash');
   if r->>'authorized' is distinct from 'true' then
    if r->>'reason'='needs_re_review' then raise exception using errcode='PZ001',message='needs_re_review';end if;
    raise exception 'ZOHO_BRIDGE_POLICY';end if;
   if j.permit_deadline<=clock_timestamp() or j.read_deadline<=clock_timestamp() or j.expires_at<=clock_timestamp()
    or j.frame is distinct from app.zoho_bound_claim_frame(p_owner_id,p_workspace_id,p_invoice_id) then raise exception 'ZOHO_BRIDGE_EXPIRED';end if;
  end if;
  delete from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=i.id;
 elsif p_action='failed' then
  insert into app.zoho_reminder_transaction_context values(pg_backend_pid(),txid_current(),i.id,p_owner_id,'failure',j.id);
  insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),j.id);
  update app.zoho_bound_claims set state=case when posting_started_at is not null then 'quarantined' else 'cancelled' end,read_nonce=null
   where id=j.id and state not in ('accepted','failed','cancelled');
  update public.cetld_core_automation_delivery_claims set status=case when j.posting_started_at is not null then 'quarantined' else 'failed' end,last_error='bound_delivery_unavailable'
   where id=p_claim_id and status in ('claimed','sending');
  update app.first_party_reminder_dispatches set state='uncertain',last_error='bound_delivery_unavailable' where claim_id=p_claim_id and state='reserved';
  delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=j.id;
  delete from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=i.id;
  r:='{"ok":true}';
 end if;
 return r;
exception when sqlstate 'PZ001' then
 return '{"ok":false,"authorized":false,"reason":"needs_re_review"}';
when others then
 -- Subtransaction rollback restores both contexts and every attempted write.
 return '{"ok":false,"authorized":false,"reason":"bound_reminder_unavailable"}';
end $$;
revoke all on function public.cetld_zoho_bound_reminder(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cetld_zoho_bound_reminder(uuid,uuid,uuid,text,uuid,jsonb) to service_role;

create function app.zoho_bound_owner_reminder(p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid,p_send_now boolean,p_preview text,p_approval_text text,p_template jsonb,p_snapshot jsonb,p_apply boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
 if auth.role() is distinct from 'service_role' or not app.owner_assistant_authorized(p_workspace_id,p_owner_id)
  or public.cetld_zoho_original_bound_read_context(p_owner_id,p_workspace_id,p_invoice_id) is null
  or p_template ? 'reviewedDelivery' then
  return '{"ok":false,"code":"external_accounting_required"}';end if;
 insert into app.zoho_reminder_transaction_context values(pg_backend_pid(),txid_current(),p_invoice_id,p_owner_id,'approval',null);
 r:=app.zoho_reminder_owner(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_apply);
 delete from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=p_invoice_id;
 return r;
end $$;
revoke all on function app.zoho_bound_owner_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

-- Existing token-bound signed-webhook/HTTP acceptance route. No caller may
-- choose a new invoice/owner/claim here; all identity comes from reservation.
create function app.zoho_bound_receipt(p_callback_token text,p_waba_id text,p_phone_number_id text,p_phone text,p_message_id text,p_status text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d app.first_party_reminder_dispatches;j app.zoho_bound_claims;b app.zoho_reminder_core_bindings;r jsonb;
begin
 select * into d from app.first_party_reminder_dispatches where callback_token=p_callback_token;
 select * into b from app.zoho_reminder_core_bindings where core_claim_id=d.claim_id;
 select * into j from app.zoho_bound_claims where id=b.journal_id;
 if j.id is null or j.posting_started_at is null or j.attempt_id is null
  or j.state not in ('posting','quarantined','accepted','failed')
  or p_status is null or p_status not in ('accepted','sent','delivered','read','failed')
  or p_message_id is null or length(p_message_id) not between 1 and 256 or p_message_id~'[[:cntrl:]]'
  or d.owner_id<>j.owner_id or d.workspace_id<>j.workspace_id or d.invoice_id<>j.invoice_id or d.customer_id<>j.customer_id
  or d.phone is distinct from p_phone or d.snapshot#>>'{template,wabaId}' is distinct from p_waba_id
  or d.snapshot#>>'{template,phoneNumberId}' is distinct from p_phone_number_id then return '{"ok":false}';end if;
 perform pg_advisory_xact_lock(hashtextextended(d.phone,0));
 perform 1 from public.workspace_settings where workspace_id=d.workspace_id for share;
 perform 1 from public.customers where workspace_id=d.workspace_id and id=d.customer_id for share;
 perform 1 from public.invoices where workspace_id=d.workspace_id and id=d.invoice_id for update;
 perform 1 from public.cetld_core_automation_delivery_claims where id=d.claim_id for update;
 select * into j from app.zoho_bound_claims where id=j.id for update;
 select * into d from app.first_party_reminder_dispatches where claim_id=d.claim_id for update;
 if j.provider_message_id is not null and j.provider_message_id<>p_message_id
  or d.provider_message_id is not null and d.provider_message_id<>p_message_id then return '{"ok":false}';end if;
 insert into app.zoho_reminder_transaction_context values(pg_backend_pid(),txid_current(),j.invoice_id,j.owner_id,'receipt',j.id);
 insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),j.id);
 insert into app.zoho_bound_claim_receipts(claim_id,attempt_id,provider_message_id,status) values(j.id,j.attempt_id,p_message_id,p_status) on conflict do nothing;
 -- Terminal journal BEFORE legitimate public counters change; transaction is
 -- atomic. Broad invalidation still cancels ALL nonterminal edit/STOP races.
 update app.zoho_bound_claims set provider_message_id=p_message_id,
 state=case when p_status='failed' and receipt_rank<2 then 'failed' when state='failed' and p_status in ('accepted','sent') then state else 'accepted' end,
 receipt_rank=greatest(receipt_rank,case p_status when 'read' then 3 when 'delivered' then 2 when 'accepted' then 1 when 'sent' then 1 else 0 end) where id=j.id;
 r:=app.zoho_reminder_receipt(p_callback_token,p_waba_id,p_phone_number_id,p_phone,p_message_id,p_status);
 if r->>'ok' is distinct from 'true' then raise exception 'ZOHO_RECEIPT_REJECTED';end if;
 delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=j.id;
 delete from app.zoho_reminder_transaction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=j.invoice_id;
 return r;
exception when others then return '{"ok":false}';
end $$;
revoke all on function app.zoho_bound_receipt(text,text,text,text,text,text) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app.owner_assistant_reminder(p_workspace_id uuid, p_owner_id uuid, p_invoice_id uuid, p_send_now boolean, p_preview text, p_approval_text text, p_template jsonb, p_snapshot jsonb, p_apply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;d jsonb:=p_template->'reviewedDelivery';i public.invoices%rowtype;s public.workspace_settings%rowtype;x public.customers%rowtype;
 deadline timestamptz;core jsonb;fallback jsonb;approval_id uuid;stamp timestamptz:=clock_timestamp();t record;
begin
 if exists(select 1 from public.invoices v where v.id=p_invoice_id and v.workspace_id=p_workspace_id and app.invoice_has_external_ledger(v)) then
  return app.zoho_bound_owner_reminder(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_apply);
 end if;
 if d is null then return app.owner_assistant_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_preview,p_approval_text,p_template,p_snapshot,p_apply);end if;
 if not app.owner_assistant_authorized(p_workspace_id,p_owner_id) then return '{"ok":false,"code":"DENIED"}';end if;
 -- The old gate locks and rechecks every eligibility fact without applying an approval.
 r:=app.owner_assistant_reminder_template_gate(p_workspace_id,p_owner_id,p_invoice_id,p_send_now,p_template->>'templatePreview',
 app.normalize_reminder_punctuation(p_template->>'templatePreview')||E'\n\n'||(select app.normalize_reminder_punctuation(business_name) from public.workspace_settings where workspace_id=p_workspace_id),p_template,p_snapshot,false);
 if r->>'ok' is distinct from 'true' then return r;end if;
 select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id;
 select * into s from public.workspace_settings where workspace_id=p_workspace_id;
 select * into x from public.customers where workspace_id=p_workspace_id and id=i.customer_id;
 deadline:=app.reminder_window_deadline(p_workspace_id,x.id,x.phone);stamp:=clock_timestamp();
 if d->>'version' is distinct from '2' or d->>'type' not in ('template','freeform') or d->>'tone' not in ('gentle','relaxed','firm','professional')
 or d->>'mode' is distinct from (case when p_send_now then 'immediate' else 'scheduled' end)
 or d->>'body' is distinct from p_preview or length(p_preview) not between 1 and 4000 or d ? 'approvalId' then return '{"ok":false,"code":"INVALID"}';end if;
 -- The tone is frozen to the exact template proposed at review, not business defaults at dispatch.
 select * into t from app.first_party_reminder_templates where waba_id='1734116767674237' and name=p_template->>'name' and revision=p_template->>'revision' and language=p_template->>'language' and approved;
 if not found or t.parameter_count<>5 or t.tone is distinct from (case d->>'tone' when 'gentle' then 'relaxed' else d->>'tone' end) then return '{"ok":false,"code":"template_unavailable"}';end if;
 core:=jsonb_build_object('type','template','name',t.name,'language',t.language,'revision',t.revision,'parameters',p_template->'parameters','body',p_template->'templatePreview','buttonVariant',t.button_variant);
 if app.checked_reminder_template(i,s,x,core) is null then return '{"ok":false,"code":"template_unavailable"}';end if;
 if d->>'type'='template' then
  if app.reminder_template_core(d) is distinct from core or p_approval_text is distinct from app.reminder_artifact_text(d,p_preview,s.business_name) or d->'fallback' not in ('null'::jsonb) then return '{"ok":false,"code":"INVALID"}';end if;
 else
  if not p_send_now then return '{"ok":false,"code":"scheduled_template_only"}';end if;
  if p_approval_text is distinct from app.reminder_artifact_text(d,p_preview,s.business_name) or d->>'body' ~ U&'[\0001-\0008\000b\000c\000e-\001f\007f]' then return '{"ok":false,"code":"INVALID"}';end if;
  if d->'fallback' is not null and d->'fallback'<>'null'::jsonb then
   fallback:=app.checked_reminder_template(i,s,x,d->'fallback');
   if fallback is null or fallback is distinct from core then return '{"ok":false,"code":"INVALID_FALLBACK"}';end if;
  end if;
  -- A deadline snapshot never grants a new window. Confirmation rechecks the current one.
  if deadline is null or deadline<=stamp or (d->>'windowExpiresAt')::timestamptz is distinct from deadline then return '{"ok":false,"code":"undeliverable_window_expired"}';end if;
 end if;
 if not p_apply then return jsonb_build_object('ok',true,'preview',p_preview,'delivery',d,'windowExpiresAt',deadline);end if;
 approval_id:=gen_random_uuid();d:=d||jsonb_build_object('approvalId',approval_id);
 insert into app.reminder_approvals(id,workspace_id,owner_id,invoice_id,approved_form,delivery,approved_text,approved_template,approved_fallback_template,window_deadline,approved_at)
 values(approval_id,p_workspace_id,p_owner_id,p_invoice_id,d->>'type',d,p_preview,case when d->>'type'='template' then core end,fallback,deadline,stamp);
 update public.invoices set metadata=(metadata-'reminder_review_reason')||jsonb_build_object('followup_state','approved','reminder_text',p_approval_text,'reminder_draft_text',p_template->>'dashboardDraft','reminder_draft_tone',d->>'tone','approved_reminder_text',p_approval_text,
 'approved_preferences_updated_at',s.updated_at,'approved_reminder_delivery_reviewed_at',stamp,'approved_reminder_delivery',d,'next_follow_up_at',case when p_send_now then stamp else next_follow_up_at end),
 followup_state='approved',next_follow_up_at=case when p_send_now then stamp else next_follow_up_at end where workspace_id=p_workspace_id and id=i.id returning * into i;
 if i.followup_state<>'approved' or i.metadata->'approved_reminder_delivery' is distinct from d then raise exception 'approval invalidated';end if;
 return jsonb_build_object('ok',true,'completed',true,'action','reminder.approved','invoiceNumber',i.invoice_number,'sendNow',p_send_now,'delivery',d);
end $function$
;
CREATE OR REPLACE FUNCTION public.cetld_core_record_first_party_receipt(p_callback_token text, p_waba_id text, p_phone_number_id text, p_phone text, p_message_id text, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d app.first_party_reminder_dispatches%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;
  next_at timestamptz; rank_old integer;rank_new integer; own_reconciled_version bigint;
begin
 if exists(select 1 from app.first_party_reminder_dispatches probe join app.zoho_reminder_core_bindings mapping on mapping.core_claim_id=probe.claim_id where probe.callback_token=p_callback_token) then
  return app.zoho_bound_receipt(p_callback_token,p_waba_id,p_phone_number_id,p_phone,p_message_id,p_status);
 end if;
  if p_status is null or p_status not in ('accepted','sent','delivered','read','failed') or p_message_id is null or length(p_message_id) not between 1 and 256 then return '{"ok":false}';end if;
  select * into d from app.first_party_reminder_dispatches where callback_token=p_callback_token;
  if d.claim_id is null or d.phone is distinct from p_phone or d.snapshot#>>'{template,wabaId}' is distinct from p_waba_id or d.snapshot#>>'{template,phoneNumberId}' is distinct from p_phone_number_id then return '{"ok":false}';end if;
  perform pg_advisory_xact_lock(hashtextextended(d.phone,0));
  select * into s from public.workspace_settings where workspace_id=d.workspace_id for share;
  select * into i from public.invoices where workspace_id=d.workspace_id and id=d.invoice_id for update;
  perform 1 from public.cetld_core_automation_delivery_claims where id=d.claim_id for update;
  select * into d from app.first_party_reminder_dispatches where claim_id=d.claim_id for update;
  if d.provider_message_id is not null and d.provider_message_id<>p_message_id then return '{"ok":false}';end if;
  if exists(select 1 from app.first_party_reminder_dispatches where provider_message_id=p_message_id and claim_id<>d.claim_id) then return '{"ok":false}';end if;
  insert into app.first_party_reminder_receipt_events(callback_token,provider_message_id,status)
    values(p_callback_token,p_message_id,p_status) on conflict do nothing;
  if p_status='accepted' then
    update public.whatsapp_messages set status='accepted',provider_message_id=p_message_id,updated_at=clock_timestamp()
      where workspace_id=d.workspace_id and callback_token=p_callback_token and status in ('unknown','pending');
  else perform public.whatsapp_record_delivery_status(p_message_id,p_phone,p_status,p_callback_token);end if;
  rank_old:=case d.state when 'accepted' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  rank_new:=case p_status when 'accepted' then 1 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if rank_new=0 and rank_old>=2 then return '{"ok":true}';end if;
  -- HTTP acceptance and sent are weaker than a signed conclusive failure.
  -- Delivered/read may supersede it, retaining the complete receipt audit.
  if d.state='failed' and rank_new=1 then return '{"ok":true,"status":"failed"}';end if;
  update app.first_party_reminder_dispatches set state=case when rank_new>=rank_old then case p_status when 'sent' then 'accepted' else p_status end else state end,
    provider_message_id=p_message_id,receipt_at=coalesce(receipt_at,clock_timestamp()) where claim_id=d.claim_id;
  if rank_new=0 then
    update app.first_party_reminder_dispatches set state='failed',last_error='signed_provider_failure' where claim_id=d.claim_id;
    update public.cetld_core_automation_delivery_claims set status='failed',provider_message_id=p_message_id,last_error='signed_provider_failure' where id=d.claim_id;
    update public.cetld_core_automation_messages set status='failed',provider_message_id=p_message_id where workspace_id=d.workspace_id and payload->>'claimId'=d.claim_id::text;
    -- Pause only the exact invoice state produced by this dispatch. Never undo
    -- a newer owner edit, payment, STOP, settings edit or review. Accepted counts
    -- remain attempts; no subtraction or retry is safe after provider acceptance.
    if d.state<>'failed' and i.deleted_at is null
      and i.automation_version=coalesce(d.reconciled_invoice_version,(d.snapshot->>'invoiceVersion')::bigint)
      and s.updated_at=(d.snapshot->>'preferencesUpdatedAt')::timestamptz
      and i.followup_state in ('approved','active','scheduled') and app.reminder_local_status_payable(i)
      and i.amount_paid<i.total_amount and i.metadata->>'invoice_direction'='receivable' then
      update public.invoices set followup_state='paused',next_follow_up_at=null,
        metadata=metadata-'approved_reminder_text'-'approved_preferences_updated_at'
        where workspace_id=d.workspace_id and id=d.invoice_id;
    end if;
    return '{"ok":true,"status":"failed"}';
  end if;
  update public.cetld_core_automation_delivery_claims set status='sent',provider_message_id=p_message_id,last_error=null where id=d.claim_id;
  update public.cetld_core_automation_messages set status='sent',provider_message_id=p_message_id where workspace_id=d.workspace_id and payload->>'claimId'=d.claim_id::text;
  if not d.counted and i.deleted_at is null then
    -- Already committed normal engine receipt/count wins. A recovered receipt
    -- never overwrites payment/pause/STOP/changed preferences or edited facts.
    if i.reminder_count<=d.count_before then
      next_at:=i.next_follow_up_at;
      if i.metadata#>>'{approved_reminder_delivery,version}'='2' and i.metadata#>>'{approved_reminder_delivery,mode}'='immediate' then next_at:=null;end if;
      if i.automation_version=(d.snapshot->>'invoiceVersion')::bigint and i.followup_state in ('approved','active','scheduled')
        and not (coalesce(i.metadata#>>'{approved_reminder_delivery,version}','')='2' and coalesce(i.metadata#>>'{approved_reminder_delivery,mode}','')='immediate')
        and i.amount_paid<i.total_amount and app.reminder_local_status_payable(i) and i.metadata->>'invoice_direction'='receivable'
        and s.updated_at=(d.snapshot->>'preferencesUpdatedAt')::timestamptz
        and not exists(select 1 from public.whatsapp_global_suppressions where phone=d.phone)
        and not exists(select 1 from public.whatsapp_suppressions where workspace_id=d.workspace_id and phone=d.phone) then
        next_at:=app.core_next_contact(clock_timestamp()+make_interval(days=>coalesce((s.follow_up_preferences->>'cadenceDays')::integer,3)),s.follow_up_preferences,s.default_timezone);
        if i.reminder_count+1>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then next_at:=null;end if;
      end if;
      update public.invoices set reminder_count=reminder_count+1,last_follow_up_at=greatest(coalesce(last_follow_up_at,d.reserved_at),d.reserved_at),
        next_follow_up_at=next_at,followup_state=case when next_at is null and followup_state in ('approved','active','scheduled') then 'paused' else followup_state end
        where workspace_id=d.workspace_id and id=d.invoice_id returning automation_version into own_reconciled_version;
    end if;
    update app.first_party_reminder_dispatches set counted=true,reconciled_invoice_version=own_reconciled_version where claim_id=d.claim_id;
  end if;
  return '{"ok":true}';
end $function$
;

do $bridge_acl$
declare r record;p oid;
begin
 for r in select * from (values
 ('app.zoho_reminder_transaction_context'),('app.zoho_reminder_core_bindings')) expected(relation) loop
  p:=to_regclass(r.relation);
  if not (select relrowsecurity and pg_get_userbyid(relowner)='postgres' from pg_class where oid=p)
   or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid=p and a.grantee<>c.relowner)
   or exists(select 1 from pg_attribute c cross join lateral aclexplode(c.attacl) a where c.attrelid=p and a.grantee<>'postgres'::regrole)
   or exists(select 1 from pg_policy where polrelid=p) then raise exception 'Zoho bridge new private ACL/RLS drift';end if;
 end loop;
 for r in select * from pg_proc where pronamespace='app'::regnamespace and proname in
 ('zoho_reminder_context_payable','zoho_reminder_payment','zoho_reminder_claim','zoho_reminder_authorize','zoho_reminder_final',
  'zoho_reminder_template_gate','zoho_reminder_owner','zoho_reminder_receipt','guard_zoho_reminder_core','zoho_bound_owner_reminder','zoho_bound_receipt')
 or oid='public.cetld_zoho_bound_reminder(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure loop
  if pg_get_userbyid(r.proowner)<>'postgres' or not r.prosecdef or not r.proconfig @> array['search_path=""']
   or exists(select 1 from aclexplode(coalesce(r.proacl,acldefault('f',r.proowner))) a where a.grantee<>r.proowner and
    (r.oid<>'public.cetld_zoho_bound_reminder(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure or a.grantee<>'service_role'::regrole or a.is_grantable)) then
   raise exception 'Zoho bridge new function ACL/security drift: %',r.proname;end if;
 end loop;
end $bridge_acl$;

commit;
