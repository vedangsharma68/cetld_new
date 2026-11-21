import {prepareSignupInvite,INVITE_NOTICE,signupWithInvite} from './signup-invite.mjs';
export async function redeemInvitation(client,{email,code,password,provider='email',redirectTo}){
 const capability=await client.rpc('signup_invite_status');
 if(capability.error||capability.data?.version!==2||capability.data?.accountInvites!==true||capability.data?.tenantInvites!==true||capability.data?.identityCredentialScrub!==true)throw Error('Invitation signup is being updated. Please try your invitation link again shortly. Existing sign-in remains available.');
 const session=await client.auth.getSession();if(session.error)throw session.error;
 if(session.data?.session){const r=await client.rpc('redeem_workspace_invite',{p_code:code});if(r.error||r.data?.ok!==true)throw Error(INVITE_NOTICE);return {tenantReady:true};}
 const ticket=await prepareSignupInvite(client,{email,code});
 if(provider==='google'){const result=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(result.error)throw result.error;return {redirecting:true};}
 const result=await signupWithInvite(client,{email,password,options:{emailRedirectTo:redirectTo,data:{signup_invite_ticket:ticket}}});if(result.error)throw Error(INVITE_NOTICE);return {checkEmail:!result.data?.session,accountReady:Boolean(result.data?.session)};
}
if(typeof document!=='undefined'&&document.querySelector('#invite-entry')){
 const form=document.querySelector('#invite-entry'),message=document.querySelector('#invite-message');
 const {config}=await import('./config.js'),{createClient}=await import('https://esm.sh/@supabase/supabase-js@2.116.0');
 const client=createClient(config.url,config.key,{auth:{persistSession:true,autoRefreshToken:true,flowType:'pkce'}});
 const session=await client.auth.getSession();if(session.data?.session){form.elements.email.value=session.data.session.user.email;form.elements.email.readOnly=true;form.elements.password.required=false;form.elements.password.closest('label').hidden=true;document.querySelector('#invite-google').hidden=true;}
 async function submit(provider){message.textContent='';const values=new FormData(form);try{const r=await redeemInvitation(client,{email:values.get('email'),code:values.get('code'),password:values.get('password'),provider,redirectTo:location.origin+'/app/'});if(r.checkEmail)message.textContent='Check your email to confirm your account, then sign in.';else if(!r.redirecting)location.assign('/app/');}catch(error){message.textContent=error.message||INVITE_NOTICE;}}
 form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())submit('email');});document.querySelector('#invite-google').addEventListener('click',()=>{if(form.elements.email.reportValidity()&&form.elements.code.reportValidity())submit('google');});
}
