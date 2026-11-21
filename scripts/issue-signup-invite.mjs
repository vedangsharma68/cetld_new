#!/usr/bin/env node
import {createClient} from '@supabase/supabase-js';
import {pathToFileURL} from 'node:url';
export async function issueSignupInvite({email,hours=24,env=process.env,client}){
 if(!Number.isFinite(hours)||hours<=0||hours>168)throw Error('Expiry must be greater than zero and at most 168 hours.');
 if(!client){if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('Set server-only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');client=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});}
 const {data,error}=await client.rpc('issue_signup_invite',{p_email:email,p_expires_at:new Date(Date.now()+hours*3600000).toISOString()});
 if(error)throw Error('Invite issuance failed. Check email, expiry and service-role access.');
 return data;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const data=await issueSignupInvite({email:process.argv[2],hours:process.argv[3]===undefined?24:Number(process.argv[3])});process.stdout.write(JSON.stringify(data,null,2)+'\n');}
 catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
