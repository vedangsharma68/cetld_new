import {signupError,signupWithInvite} from './signup-invite.mjs';
export async function registerAccount(client,{email,password,provider='email',redirectTo}){
 if(provider==='google'){const result=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(result.error)throw result.error;return {redirecting:true};}
 const result=await signupWithInvite(client,{email,password,options:{emailRedirectTo:redirectTo}});if(result.error)throw Error(signupError(result.error));return {checkEmail:!result.data?.session,accountReady:Boolean(result.data?.session)};
}
if(typeof document!=='undefined'&&document.querySelector('#invite-entry')){
 const form=document.querySelector('#invite-entry'),message=document.querySelector('#invite-message');
 const {config}=await import('./config.js'),{createClient}=await import('https://esm.sh/@supabase/supabase-js@2.116.0');
 const client=createClient(config.url,config.key,{auth:{persistSession:true,autoRefreshToken:true,flowType:'pkce'}});
 const session=await client.auth.getSession();if(session.data?.session)location.assign('/app/');
 async function submit(provider){message.textContent='';const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);const values=new FormData(form);try{const r=await registerAccount(client,{email:values.get('email'),password:values.get('password'),provider,redirectTo:location.origin+'/app/'});if(r.checkEmail)message.textContent='Check your email to confirm your account, or sign in if you already have one.';else if(!r.redirecting)location.assign('/app/');}catch(error){message.textContent=error.message||'Unable to create account. Please try again.';}finally{buttons.forEach(b=>b.disabled=false);}}
 form.addEventListener('submit',event=>{event.preventDefault();if(form.reportValidity())submit('email');});document.querySelector('#invite-google').addEventListener('click',()=>submit('google'));
}
