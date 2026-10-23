const PERSONAL_NOTE_REPLY = 'I can only help with your invoices and business data.';

// An explicit personal-note envelope is not a business command, even when its
// body mentions money, dates, business words or "save it". Ordinary invoice
// commands and field-only "notes: ..." edits keep their existing paths.
export function personalNoteReply(message) {
  if(typeof message!=='string'||!message.trim()||message.length>4000)return null;
  const text=message.normalize('NFKC').trim().toLowerCase();
  return /^(?:notes?(?:\s*-\s*|\s+)to(?:\s*-\s*|\s+)(?:myself|self)|(?:personal|private)\s+note)\b/u.test(text)
    ?PERSONAL_NOTE_REPLY:null;
}
