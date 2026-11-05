import {createHash} from 'node:crypto';
import {privateOriginKeys} from '../../ai/private-value-matcher.mjs';

// RPC contract for strict in-memory subsystem stores. Production integration
// coverage uses the SQL migration, not this simulator. Unsupported document
// forms reject rather than acknowledge retention without storing canonical keys.
export function retainPrivateOriginFixture(tables,args){
 if(typeof args.p_workspace_id!=='string'||!args.p_workspace_id||typeof args.p_text!=='string'||!args.p_text.length||args.p_text.length>4000)return {error:{code:'INVALID_PRIVATE_ORIGIN'}};
 const keys=privateOriginKeys(args.p_text);
 if(!keys.length)return {error:{code:'UNSUPPORTED_PRIVATE_ORIGIN'}};
 const terms=tables.whatsapp_private_invoice_terms||=([]);
 for(const term of keys){
  const term_hash=createHash('sha256').update(term).digest('hex');
  if(!terms.some(row=>row.workspace_id===args.p_workspace_id&&row.term_hash===term_hash))terms.push({workspace_id:args.p_workspace_id,term_hash,term});
 }
 return {data:true};
}
