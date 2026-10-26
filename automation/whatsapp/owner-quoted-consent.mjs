// Source resolution and consent writes stay in SQL. These bounded presentation
// helpers never turn a reported agreement into approval of reminder wording.
export const QUOTED_TARGET_CLARIFICATION='Which customer and invoice is this for? That reply has no verified current saved-phone target.';
export function isOwnerConsentTopic(message){
  return /\b(?:consent(?:ed)?|agreed|approv(?:e|es|ed|al))\b/i.test(String(message||''));
}
export function quotedConsentDateReply(target,timezone){
  if(!target.relativeDue)return '';
  const timestamp=Date.parse(target.messageTimestamp||'');
  if(!Number.isFinite(timestamp)||!target.invoiceId)return 'Which invoice and exact due date should I use? No due date was changed and no reminder was sent.';
  let parts;
  try{parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));}
  catch{return 'What exact due date should I use? No due date was changed and no reminder was sent.';}
  const value=type=>Number(parts.find(p=>p.type===type)?.value);
  const tomorrow=new Date(Date.UTC(value('year'),value('month')-1,value('day')+1)).toISOString().slice(0,10);
  return `You reported invoice ${target.invoiceNumber} due tomorrow: ${tomorrow} (${timezone}, from your original message). Its saved due date is ${target.dueDate||'not shown'}. To change it, say “set invoice ${target.invoiceNumber} due date to ${tomorrow}”. No due date was changed. Then request a reminder preview and approve its exact wording; no reminder was sent.`;
}
