// Temporary diagnostic. Removed after the Cloudflare handwriting test.
export const config={api:{bodyParser:{sizeLimit:'4mb'}}};
export default async function handler(req,res){
  if(req.query?.t!=='ky21rzxiwioz936l')return res.status(404).end();
  const id=process.env.CLOUDFLARE_ACCOUNT_ID,key=process.env.CLOUDFLARE_API_TOKEN;
  const {model,image,prompt}=req.body||{};const t0=Date.now();
  try{
    const body={model,max_tokens:400,messages:[{role:'user',content:[{type:'text',text:prompt||'Extract JSON.'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+image}}]}]};
    const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+id+'/ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
    const j=await r.json().catch(()=>({}));
    res.status(200).json({status:r.status,ms:Date.now()-t0,text:j?.choices?.[0]?.message?.content||'',neurons:j?.usage?.neurons,err:r.ok?undefined:JSON.stringify(j?.errors||j).slice(0,200)});
  }catch(e){res.status(200).json({err:String(e?.message).slice(0,100),ms:Date.now()-t0});}
}
