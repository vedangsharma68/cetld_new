// Temporary diagnostic. Removed after the Cloudflare vision test.
import {createCanvas} from '@napi-rs/canvas';
const MODELS=['@cf/meta/llama-4-scout-17b-16e-instruct','@cf/meta/llama-3.2-11b-vision-instruct','@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/google/gemma-3-12b-it'];
function invoice(){const c=createCanvas(900,600),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,900,600);x.fillStyle='#000';x.font='bold 36px sans-serif';x.fillText('INVOICE  INV-2041',40,70);x.font='24px sans-serif';
[['Bill to: Acme Traders Pvt Ltd',130],['Issue date: 2026-09-28    Due date: 2026-10-12',175],['Design work           1 x 12,500.00',260],['Hosting               2 x 2,000.00',300],['Subtotal 16,500.00   GST 18%  2,970.00',380],['TOTAL (INR)  19,470.00',440]].forEach(([t,y])=>x.fillText(t,40,y));return c.toBuffer('image/png').toString('base64');}
export default async function handler(req,res){
  if(req.query?.t!=='cavzdt7k')return res.status(404).end();
  const id=process.env.CLOUDFLARE_ACCOUNT_ID,key=process.env.CLOUDFLARE_API_TOKEN;const img=invoice();const out=[];
  for(const model of (req.query.m?String(req.query.m).split(','):MODELS)){
    const t0=Date.now();
    try{
      const body={model,max_tokens:300,messages:[{role:'user',content:[{type:'text',text:'Extract this invoice as compact JSON: invoiceNumber, customer, issueDate, dueDate, currency, subtotal, tax, total. JSON only.'},{type:'image_url',image_url:{url:'data:image/png;base64,'+img}}]}]};
      const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+id+'/ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
      const j=await r.json().catch(()=>({}));
      out.push({model,status:r.status,ms:Date.now()-t0,text:String(j?.choices?.[0]?.message?.content||'').slice(0,400),neurons:j?.usage?.neurons,err:r.ok?undefined:JSON.stringify(j?.errors||j?.error||j).slice(0,200)});
    }catch(e){out.push({model,ms:Date.now()-t0,err:String(e?.message).slice(0,100)});}
  }
  res.status(200).json(out);
}
