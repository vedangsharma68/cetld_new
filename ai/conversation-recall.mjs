// Recall quotes the owner's words; it never treats a historical statement as a
// current invoice fact or as permission to repeat an earlier action.
export function conversationRecallRequest(message) {
  const text=message.trim().toLowerCase().replace(/[!?.,]+$/g,'').replace(/\s+/g,' ');
  const latestQuestion=/^(?:what did i (?:just )?ask(?: you)?|what was my (?:last|previous|most recent) question|what did i (?:last|previously) ask(?: you)?|remind me what i (?:just |last |previously )?asked(?: you)?)$/.test(text);
  const speech='(?:tell|say|send|message|ask|mention|share|write)';
  const pastSpeech='(?:told|said|sent|messaged|asked|mentioned|shared|wrote)';
  const conversationAnchor=/\b(?:you|whatsapp|web|dashboard|browser|chat|conversation|marker|codeword)\b/.test(text);
  // Sending to a customer asks about delivery records, even when WhatsApp is
  // named. An explicit "told you" still recalls the owner's earlier words.
  if(!/\b(?:tell|told|ask|asked)\s+you\b/.test(text)&&/\b(?:send|sent|share|shared|write|wrote|message|messaged)\b[^.!?;]{0,100}\bto\s+(?!you\b|the (?:assistant|bot)\b)[\p{L}]/u.test(text))return null;
  const recall=latestQuestion
    || conversationAnchor&&(new RegExp(`\\bwhat did i (?:just |last |previously |already )?${speech}\\b`).test(text)
      || new RegExp(`\\bwhat (?:have i|i) (?:just |last |previously |already )?${pastSpeech}\\b`).test(text))
    || new RegExp(`\\b(?:recall|remember|quote|repeat|remind me)\\b.*\\b(?:i (?:just |previously |already )?${pastSpeech}|my (?:earlier |previous |last )?(?:(?:whatsapp|web|dashboard|browser) )?(?:message|question|test marker|marker))\\b`).test(text)
    || new RegExp(`\\b(?:what|which)\\b.*\\b(?:marker|codeword|message)\\b.*\\bi (?:just |previously )?${pastSpeech}\\b`).test(text)
    || /\bwhat (?:was|is) my (?:earlier |previous |last |test )?(?:marker|codeword)\b/.test(text)&&/\b(?:whatsapp|web|dashboard|browser|chat|conversation|earlier|previous)\b/.test(text);
  if(!recall)return null;
  const channels=[...text.matchAll(/\b(?:on|via|in|over|through|from)\s+(?:the\s+)?(whatsapp|web|dashboard|browser)\b/g)];
  const named=channels.at(-1)?.[1]||text.match(/\bmy (?:earlier |previous |last )?(whatsapp|web|dashboard|browser) (?:message|question|marker)\b/)?.[1];
  const channel=named==='whatsapp'?'whatsapp':named?'web':null;
  const topic=text.match(/\b(?:about|regarding)\s+(.+?)(?:[.!?;]|$)/)?.[1]
    || text.match(/\b(?:test marker|marker|codeword)\b/)?.[0] || '';
  const ignored=new Set(['the','and','that','this','with','from','you','your','told','said','sent','tell','what','which','was','were','earlier','before','ago','few','minutes','minute','seconds','second','whatsapp','web','dashboard','browser','quote','please']);
  const terms=[...new Set((topic.match(/[\p{L}\p{N}-]+/gu)||[]).filter(word=>word.length>2&&!ignored.has(word)))];
  return {latestQuestion,channel,terms};
}

export function conversationRecallAnswer(request,history,redact) {
  if(request.latestQuestion){
    const previous=history.findLast(turn=>turn.role==='user');
    return previous?`Your latest question was: “${redact(previous.content)}”`:"I don't have an earlier question from you in this chat.";
  }
  const label=request.channel==='whatsapp'?'WhatsApp':request.channel==='web'?'web':null;
  const candidates=history.filter(turn=>turn.role==='user'&&(!request.channel||turn.channel===request.channel)&&!conversationRecallRequest(turn.content));
  if(!candidates.length)return `I don't have an earlier ${label?label+' ':''}message from you in the recent business conversation.`;
  // Prefer an explicitly named topic while retaining chronological order for
  // ties. Only verbatim stored user content is returned, never model prose.
  const ranked=candidates.map((turn,index)=>({turn,index,score:request.terms.filter(word=>turn.content.toLowerCase().includes(word)).length}))
    .sort((a,b)=>b.score-a.score||b.index-a.index);
  return `Your ${ranked[0].score?'earlier':'latest'}${label?' '+label:''} message was: “${redact(ranked[0].turn.content)}”`;
}
