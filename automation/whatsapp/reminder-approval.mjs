// Approval binds the exact transport form as well as the rendered words. There
// is deliberately no implicit free-form -> template fallback, even when a
// service window expires or its state is unknown. Every retry checks again.
export function reminderDeliveryForm({entry,parameters,body}) {
  return {type:'template',name:entry.name,language:entry.language,revision:entry.revision,
    parameters:[...parameters],body,buttonVariant:entry.buttonVariant===true};
}
export function matchesReminderDelivery(approved,actual) {
  return approved?.type==='template'&&actual?.type==='template'
    &&['name','language','revision','body','buttonVariant'].every(k=>approved[k]===actual[k])
    &&Array.isArray(approved.parameters)&&Array.isArray(actual.parameters)
    &&approved.parameters.length===actual.parameters.length&&approved.parameters.every((v,i)=>v===actual.parameters[i]);
}
