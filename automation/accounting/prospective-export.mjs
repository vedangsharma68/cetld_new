import {AccountingError} from './errors.mjs';

const conflict=()=>new AccountingError('ACCOUNTING_EXPORT_OPERATION_CHANGED','Prospective export operation changed');
const stateIs=(value,state)=>value?.state===state&&value.provenance==='unverified';
const accountMatches=(context,connection)=>context&&connection&&[
 ['accountId','providerAccountId'],['region','region'],['apiDomain','apiDomain'],['accountsDomain','accountsDomain'],
].every(([left,right])=>context[left]===connection[right]);

// This journal NEVER supplies origin evidence or reminder authority. Only a
// future separately reviewed atomic capture protocol may do that. Legacy/no-
// epoch/recovery attempts retain the existing unverified export path.
export async function prospectiveZohoExport({store,identity,invoiceId,invoice,expectedContext,authorization,dispatch,legacyDispatch}){
 if(!expectedContext)return legacyDispatch();
 if(!accountMatches(expectedContext,authorization.connection))throw conflict();
 const current=await store.zohoOperationContext(identity);
 if(current?.epochId!==expectedContext.epochId||!accountMatches(current,authorization.connection))throw conflict();
 const operation=await store.reserveZohoExportOperation(identity,invoiceId,expectedContext.epochId,invoice);
 if(operation?.provenance!=='unverified')throw conflict();
 if(['not_admitted','retry_unverified'].includes(operation?.state))return legacyDispatch();
 if(operation?.state!=='reserved'||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(operation.operationId||''))throw conflict();
 const transition=(action,outcome=null)=>store.transitionZohoExportOperation(identity,invoiceId,operation.operationId,action,outcome);
 if(!stateIs(await transition('start'),'dispatched'))throw conflict();
 let result;
 try{
  // Pin this one attempt to prepared credentials/account. A retry that chooses
  // today's connection cannot be part of this operation. Existing adapter
  // duplicate recovery still returns an explicitly unverified outcome.
  result=await dispatch(authorization);
 }catch(error){
  if(!stateIs(await transition('finish','unknown_unverified'),'finished'))throw conflict();
  throw error;
 }
 if(!stateIs(await transition('finish',result.duplicate?'duplicate_unverified':'created_unverified'),'finished'))throw conflict();
 return result;
}
