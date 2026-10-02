// Verified-owner settings edits over WhatsApp: business name and follow-up preferences.
// Every edit is a proposal that needs an explicit yes; the database guard trigger
// re-validates the final values, so this parser only has to be strict, not complete.
const VERB=/\b(?:change|set|update|rename|edit|make|turn|switch|put)\b/i;
const TONES=['gentle','professional','firm'];
const int=(value,min,max)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null;};
function clock(hour,minute,meridian){
 let h=Number(hour);const m=Number(minute||0);
 if(meridian){const p=meridian.toLowerCase()==='pm';if(h<1||h>12)return null;h=h%12+(p?12:0);}
 if(!Number.isInteger(h)||h<0||h>23||m<0||m>59)return null;
 return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
export const UNSUPPORTED=[
 [/\b(?:owner|my)\s+(?:whatsapp\s+)?number\b|\bunlink\b|\bdisconnect\b/i,"I can't change or disconnect the owner number from WhatsApp. That stays in the dashboard under Settings, on purpose, so nobody can take over the account from a chat."],
 [/\b(?:turn|switch)\s+(?:on|off)\b.{0,30}\b(?:reminders?|customer (?:messages|delivery)|sending)\b|\benable\b.{0,30}\b(?:reminders?|delivery)\b/i,"I can't turn customer delivery on or off from WhatsApp. That stays in the dashboard on purpose."],
 [/\btime\s*zone\b/i,"I can't change the timezone from WhatsApp yet. Use the dashboard under Settings."],
 [/\b(?:default )?currency\b.{0,20}\b(?:to|as)\b/i,"I can't change the default currency from WhatsApp yet. Use the dashboard under Settings."],
 [/\b(?:ai|model|full name|profile name|my name)\b.{0,25}\b(?:to|as)\b/i,"I can't change that setting from WhatsApp yet. Use the dashboard under Settings."],
];
export function parseSettingsRequest(raw){
 const message=String(raw||'').trim();
 if(!message||!VERB.test(message))return null;
 const patch={};let name=null;
 const n=message.match(/\b(?:workspace|business|company)(?:\s+name)?\s+(?:to|as|=)\s*(.+)$/i)||message.match(/\brename\b.{0,40}?\bto\s+(.+)$/i);
 if(n&&/\b(?:name|rename)\b/i.test(message)){
  name=n[1].trim().replace(/^["“'‘]+|["”'’.]+$/g,'').trim();
  if(!name||name.length>200||/[\r\n]/.test(name))return {error:'Use a business name between 1 and 200 characters.'};
 }
 const tone=message.match(/\btone\b.{0,20}\b(gentle|professional|firm)\b/i)||message.match(/\b(?:make|set|put)\b.{0,25}\b(?:reminders?|follow.?ups?)\b.{0,20}\b(gentle|professional|firm)\b/i);
 if(tone)patch.tone=tone[1].toLowerCase();
 const max=message.match(/\b(?:max(?:imum)?(?:\s+number\s+of)?\s+reminders?|reminders?\s+(?:limit|max))\D{0,15}(\d{1,3})\b/i)||message.match(/\bat most (\d{1,3}) reminders?\b/i);
 if(max){const v=int(max[1],1,20);if(v===null)return {error:'Maximum reminders must be a whole number from 1 to 20.'};patch.maxReminders=v;}
 const every=message.match(/\b(?:remind(?:ers?)?|follow.?ups?|cadence)\b.{0,25}\bevery\s+(\d{1,3})\s+days?\b/i)||message.match(/\bcadence\D{0,15}(\d{1,3})\b/i);
 if(every){const v=int(every[1],1,90);if(v===null)return {error:'Days between reminders must be a whole number from 1 to 90.'};patch.cadenceDays=v;}
 const first=message.match(/\bfirst reminder\b.{0,30}?(\d{1,3})\s+days?\b/i);
 if(first){const v=int(first[1],0,90);if(v===null)return {error:'The first reminder delay must be a whole number from 0 to 90 days.'};patch.firstReminderDays=v;}
 const hours=message.match(/\b(?:contact|reminder|sending)\s+hours?\b\D{0,15}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
 if(hours){
  const a=clock(hours[1],hours[2],hours[3]),b=clock(hours[4],hours[5],hours[6]);
  if(!a||!b||a>=b)return {error:'Give contact hours as a start and a later end, like "contact hours 9am to 6pm".'};
  patch.contactStart=a;patch.contactEnd=b;
 }
 const toggle=message.match(/\b(?:turn|switch|set)\s+(on|off)\s+(?:the\s+)?(daily summary|pause on reply)\b/i);
 if(toggle){const on=toggle[1].toLowerCase()==='on';patch[/daily/i.test(toggle[2])?'dailySummary':'pauseOnReply']=on;}
 if(name===null&&!Object.keys(patch).length)return null;
 return {businessName:name,patch};
}
export function unsupportedAnswer(message){
 if(!VERB.test(message)&&!/\b(?:turn|switch)\b/i.test(message))return null;
 if(/\b(?:invoice|bill|inv[-#]?\d)/i.test(message))return null;
 for(const [pattern,answer] of UNSUPPORTED)if(pattern.test(message))return answer;
 return null;
}
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
