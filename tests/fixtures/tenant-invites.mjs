// Business/RLS fixtures seed approved operators through direct database writes.
// Give those explicitly listed actors tenant grants before switching to the
// authenticated API role. Auth admission tests never use this helper.
export function fixtureTenantGrantsSQL(actors,count=2){
 if(!actors.every(id=>/^[0-9a-f-]{36}$/i.test(id))||!Number.isInteger(count)||count<1)throw Error('Invalid fixture approval');
 return `insert into app.signup_invites(email,code_hash,expires_at,consumed_at,consumed_by)
 select 'fixture-'||u.id::text||'@example.test',sha256(convert_to(gen_random_uuid()::text,'UTF8')),now()+interval '1 day',now(),u.id
 from auth.users u cross join generate_series(1,${count}) where u.id in (${actors.map(id=>"'"+id+"'").join(',')});`;
}
