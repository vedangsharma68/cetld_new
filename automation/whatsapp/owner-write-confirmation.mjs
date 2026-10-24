// Input is a verified, sanitized tool result, never model arguments or text.
// Keep identifiers, metadata and other internal receipt fields out of replies.
const ENTITIES={
  customer:{label:'customer',actions:['created','updated','deleted'],fields:{name:'Name',company_name:'Company',phone:'Phone',email:'Email',custom_fields:'Custom fields'}},
  business_record:{label:'business record',actions:['created','updated','deleted','restored'],fields:{name:'Name',record_type:'Category',custom_fields:'Custom fields'}},
  settings:{label:'business settings',actions:['updated'],fields:{business_name:'Business name',default_currency:'Default currency',default_timezone:'Timezone',follow_up_preferences:'Follow-up preferences',owner_bot_preferences:'Bot preferences'}},
  ai_settings:{label:'AI settings',actions:['updated'],fields:{primary_model:'Primary model',fallback_model:'Fallback model'}},
};
const VERBS={created:'Created',updated:'Updated',deleted:'Deleted',restored:'Restored'};
const display=value=>value===null?'none':typeof value==='object'?JSON.stringify(value):String(value);

export function ownerWriteConfirmation(result){
  if(result?.ok!==true||result.completed!==true||result.proposal===true||result.requiresConfirmation===true)return null;
  const spec=ENTITIES[result.entityType],record=result.record;
  const action=spec?.actions.find(action=>result.action===`${result.entityType}.${action}`);
  if(!action||!record||typeof record!=='object'||Array.isArray(record))return null;
  const lines=Object.entries(spec.fields).filter(([field])=>Object.hasOwn(record,field))
    .map(([field,label])=>`${label}: ${display(record[field])}`);
  if(!lines.length)return null;
  const verb=result.replayed===true?`Previously ${VERBS[action].toLowerCase()}`:VERBS[action];
  return `${verb} ${spec.label}.\n${lines.join('\n')}`;
}
