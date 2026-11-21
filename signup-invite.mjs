export const INVITE_NOTICE='Access is by invite. Request an invitation using the contact details below, then enter the code issued for your email.';
export async function prepareSignupInvite(client,{email,code}){
 if(!String(email||'').trim()||!String(code||'').trim())throw Error(INVITE_NOTICE);
 const capability=await client.rpc('signup_invite_status');
 if(capability.error||capability.data?.version!==2||capability.data?.accountInvites!==true||capability.data?.tenantInvites!==true||capability.data?.identityCredentialScrub!==true)throw Error('Invitation signup is being updated. Please use your invitation link again shortly. Existing sign-in remains available.');
 const {data,error}=await client.rpc('prepare_signup_invite',{p_email:String(email).trim(),p_code:String(code).trim()});
 if(error||data?.ok!==true||data.schemaVersion!==2||!data.ticket)throw Error(INVITE_NOTICE);
 return data.ticket;
}
export const prepareGoogleSignup=prepareSignupInvite;
export function signupError(error){
 return /invite|database error|unexpected_failure|signup.*disabled/i.test(String(error?.message||error?.code||error))?INVITE_NOTICE:error?.message||'Could not create your account. Please try again.';
}

// Compatibility input may contain an invite code; GoTrue must NEVER receive it.
// Database sanitization cannot mutate GoTrue's already-built response model.
export async function signupWithInvite(client,request){
 const metadata={...(request.options?.data||{})};
 const code=metadata.signup_invite_code;delete metadata.signup_invite_code;
 if(code)metadata.signup_invite_ticket=await prepareSignupInvite(client,{email:request.email,code});
 const result=await client.auth.signUp({...request,options:{...request.options,data:metadata}});
 const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['signup_invite_code','signup_invite_ticket'].includes(key)).map(([key,v])=>[key,clean(v)])):value;
 return {...result,data:clean(result.data)};
}
