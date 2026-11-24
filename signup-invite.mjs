// Historical filename retained for cached browser imports. Signup no longer needs invitations.
export function signupError(error){
 if(/already|registered|exists/i.test(String(error?.message||error?.code||'')))return 'Check your email to confirm your account, or sign in if you already have one.';
 return error?.message||'Could not create your account. Please try again.';
}
export async function signupWithInvite(client,request){
 const metadata={...(request.options?.data||{})};
 delete metadata.signup_invite_code;delete metadata.signup_invite_ticket;
 return client.auth.signUp({...request,options:{...request.options,data:metadata}});
}
