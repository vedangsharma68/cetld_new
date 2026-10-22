// Only public, human explanations belong here. Never use an exception's raw
// message: database/provider errors can contain credentials or customer data.
const DETAILS={
  NOT_FOUND:['No matching record was found.','Check the name or invoice number and send it again.'],
  AMBIGUOUS:['More than one record matches.','Send the full customer name or invoice number.'],
  INVALID:['Some request details are missing, invalid or unsupported.','Check the details and send a clear request again.'],
  INVALID_PHONE:['The phone number is not in a supported format.','Send it with the country code, like +919818685252.'],
  DENIED:['Your owner number could not be verified for this action.','Verify it in cetld and try again.'],
  STALE:['The record changed since it was reviewed.','Review its current details and ask again.'],
  EXPIRED:['That approval expired.','Send a new request.'],
  PENDING:['Another owner change is waiting for a decision.','Confirm or cancel it first.'],
  NO_PENDING_ACTION:['There is no matching pending approval.','Send a new request.'],
  IN_USE:['This customer still has invoices.','Review their invoices in cetld first.'],
  PAYMENT_GUARD:['The payment could not be verified against the invoice and its balance.','Check the invoice currency and balance before trying again.'],
  UNAVAILABLE:['The records needed for this request are temporarily unavailable.','Try again shortly.'],
  DATABASE_UNAVAILABLE:['The records needed for this request are temporarily unavailable.','Try again shortly.'],
  UNKNOWN_TOOL:['This request uses an unsupported action.','Describe what you need in a new message.'],
  OWNER_LOOP_TIMEOUT:['The request took too long to finish.','Try a smaller request.'],
};
const failure=/\b(?:out of juice|something went wrong|didn['’]t work|did not work|could not|couldn['’]t|cannot|can['’]t|unable|failed|failure|error|unavailable|invalid|expired|not found|no match|nothing matching|no pending|outside.{0,20}restore window|already deleted|already processed)\b/i;
const reason=/\b(?:out of juice|still has invoices|waiting for (?:a decision|approval)|pending|could not be matched|could not match|couldn['’]t match|does not match|doesn['’]t match|find|missing|invalid|unsupported|unavailable|expired|changed since|changed after|more than one|no match|no (?:matching|pending)|not found|already (?:deleted|processed|exists|in use)|outside.{0,20}restore window|timed out|timeout|took too long|interrupted|quota|country code|verify|verified|read|access|load|attach|safe reply|usable reply|processing|recorded payments|payment history|owner number|owner binding|invoice currency|balance|details)\b/i;
const nextStep=/(?:^|[.!?;\n,]|\b(?:please|then|you can|so)\s+)\s*(?:try(?=\s*:)|try (?:again|a |an? )|retry|send|reply|ask|check|review|verify|choose|specify|provide|confirm|cancel|open|use|tap|wait)\b/i;
const technical=/\b(?:PGRST\d+|SQLSTATE|ECONN\w+|ETIMEDOUT|[A-Z]+_[A-Z_]+)\b|\((?:UNAVAILABLE|INVALID|DENIED|STALE|EXPIRED|AMBIGUOUS|UNKNOWN)\)/;
const opaque=/^(?:sorry[,!.]?\s*)?(?:something went wrong|that (?:didn['’]t|did not) work|an? error occurred|error|request failed|i (?:could not|couldn['’]t|cannot|can['’]t) (?:do|finish|complete|apply|process|save)(?: (?:that|this|it|the request|that request|this request|right now))*)[.!]?(?:\s*(?:please )?try again(?: shortly| later)?[.!]?)?$/i;
export function ownerFailureGuidance(reply,{code=null,failed=false,writeAttempted=false}={}) {
  const text=String(reply||'').trim();
  if(code==='NAME_CONFIRMATION_REQUIRED')return text;
  if(text==='Send it with the country code, like +919818685252.')return `${DETAILS.INVALID_PHONE[0]} ${text}`;
  if(!text||!failure.test(text)&&!failed)return text;
  const detail=DETAILS[code]||(/\bno pending\b/i.test(text)?DETAILS.NO_PENDING_ACTION:null)||[
    'I couldn’t verify the result of this request.',
    writeAttempted?'Check cetld before retrying.':'Try again shortly.',
  ];
  // Keep specific human reasons (including reminder eligibility and attachment
  // errors); fill only a missing explanation or missing recovery instruction.
  if(technical.test(text)||opaque.test(text))return detail.join(' ');
  const explained=reason.test(text)?text:`${detail[0]} ${text}`;
  const retry=/out of juice/i.test(text)?'Try again after the quota resets.':writeAttempted?'Check cetld before retrying.':detail[1];
  return nextStep.test(text)?explained:`${explained} ${retry}`;
}
