// Server-side settings storage and validated change summaries.
const LABELS={tone:'Tone',maxReminders:'Maximum reminders',cadenceDays:'Days between reminders',firstReminderDays:'First reminder, days after due',contactStart:'Contact start',contactEnd:'Contact end',pauseOnReply:'Pause when the customer replies',dailySummary:'Daily summary'};
const show=v=>typeof v==='boolean'?(v?'on':'off'):v===undefined||v===null||v===''?'not set':String(v);
export function describeSettingsChange(current,request){
 const lines=[];
 if(request.businessName!==null)lines.push(`Business name: ${show(current.business_name)} → ${request.businessName}`);
 for(const [k,v] of Object.entries(request.patch))lines.push(`${LABELS[k]}: ${show(current.follow_up_preferences?.[k])} → ${show(v)}`);
 return lines;
}
export function createOwnerSettingsStore(supabase){
 return {
  async read(workspaceId){
   const r=await supabase.from('workspace_settings').select('business_name,follow_up_preferences,updated_at').eq('workspace_id',workspaceId).maybeSingle();
   if(r.error)throw r.error;return r.data;
  },
  async write(workspaceId,expectedUpdatedAt,request,current){
   const update={};
   if(request.businessName!==null)update.business_name=request.businessName;
   if(Object.keys(request.patch).length)update.follow_up_preferences={...(current.follow_up_preferences||{}),...request.patch};
   const r=await supabase.from('workspace_settings').update(update).eq('workspace_id',workspaceId).eq('updated_at',expectedUpdatedAt).select('business_name,follow_up_preferences,updated_at');
   if(r.error)throw r.error;
   return (r.data||[])[0]||null;
  },
 };
}
