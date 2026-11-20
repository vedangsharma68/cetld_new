export const INVITE_NOTICE='Access is by invite. Request an invitation using the contact details below, then enter the code issued for your email.';
export async function prepareGoogleSignup(client,{email,code}){
 if(!String(email||'').trim()||!String(code||'').trim())throw Error(INVITE_NOTICE);
 const {data,error}=await client.rpc('prepare_signup_invite',{p_email:String(email).trim(),p_code:String(code).trim()});
 if(error||data?.ok!==true)throw Error(INVITE_NOTICE);
}
export function signupError(error){
 return /invite|database error|unexpected_failure|signup.*disabled/i.test(String(error?.message||error?.code||error))?INVITE_NOTICE:error?.message||'Could not create your account. Please try again.';
}
