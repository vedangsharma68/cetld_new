// Temporary diagnostic. Removed after the Cloudflare model test.
const MODELS=['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/meta/llama-4-scout-17b-16e-instruct','@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/openai/gpt-oss-20b','@cf/qwen/qwen3-30b-a3b-fp8','@cf/zai-org/glm-4.7-flash'];
const TOOLS=[{type:'function',function:{name:'find_invoices',description:'Find invoices by customer name',parameters:{type:'object',properties:{customer:{type:'string'}},required:['customer']}}}];
export default async function handler(req,res){
  if(req.query?.t!=='xzsowl7siwm')return res.status(404).end();
  const id=process.env.CLOUDFLARE_ACCOUNT_ID,key=process.env.CLOUDFLARE_API_TOKEN;
  if(!id||!key)return res.status(200).json({error:'env missing',hasId:!!id,hasKey:!!key});
  const out=[];
  for(const model of (req.query.m?String(req.query.m).split(','):MODELS)){
    for(const mode of ['tools','chat']){
      const t0=Date.now();
      try{
        const body={model,messages:[{role:'system',content:'You are a business assistant. Use tools to look up data.'},{role:'user',content:mode==='tools'?"what is john's invoice total?":'say hi in 5 words'}],max_tokens:200,...(mode==='tools'?{tools:TOOLS}:{})};
        const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+id+'/ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
        const j=await r.json().catch(()=>({}));
        const m=j?.choices?.[0]?.message;
        out.push({model,mode,status:r.status,ms:Date.now()-t0,toolCalls:m?.tool_calls?.map(c=>c.function?.name+':'+String(c.function?.arguments).slice(0,60)),text:String(m?.content||'').slice(0,60),usage:j?.usage,err:r.ok?undefined:JSON.stringify(j?.errors||j?.error||j).slice(0,160)});
      }catch(e){out.push({model,mode,ms:Date.now()-t0,err:String(e?.message).slice(0,100)});}
    }
  }
  res.status(200).json(out);
}
