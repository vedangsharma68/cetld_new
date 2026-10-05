import {timingSafeEqual} from 'node:crypto';
import {firstPartyReminderEnabled} from './first-party-reminder-runtime.mjs';
import {createAutomationRuntime} from './runtime.mjs';
import {uuid} from './http.mjs';

export function createReminderCronHandler({env=process.env,runtimeFactory=createAutomationRuntime}={}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='GET')return res.status(405).json({error:'GET required'});
    const expected=env.CRON_SECRET?Buffer.from('Bearer '+env.CRON_SECRET):null;
    const actual=Buffer.from(String(req.headers?.authorization||''));
    if(!expected||actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(401).json({error:'Unauthorized'});
    if(!firstPartyReminderEnabled(env))return res.status(200).json({disabled:true,processed:0});
    try{
      const scopes=JSON.parse(env.AUTOMATION_WORKSPACES||'null');
      if(!Array.isArray(scopes)||scopes.length>25)throw Error('Invalid scopes');
      const runtime=runtimeFactory({env}),results=[];
      for(const item of scopes){
        const scope={ownerId:uuid(item.ownerId),workspaceId:uuid(item.workspaceId)};
        results.push({workspaceId:scope.workspaceId,...await runtime.tick(scope)});
      }
      return res.status(200).json({results});
    }catch{return res.status(503).json({error:'Reminder scheduler unavailable'});}
  };
}
