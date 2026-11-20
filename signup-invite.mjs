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
