// These markers describe model instructions or reply construction, not business
// facts. Reject the entire draft: removing a prefix could hide contradictory or
// unsupported claims in the remaining answer. The caller repairs or fails closed.
export function internalOwnerReplyIssue(value) {
  const text=String(value||'');
  if(/(?:["'](?:replyRequirements|requiredFacts|attachmentReview|attachmentDuplicate|confirmationText|confirmationAlternatives|requiresCancel|requiresReplyCue|safetyIssueCodes)["']\s*:|\breplyRequirements\s*[:=])/i.test(text))
    return 'internal_reply_requirements';
  if(/<\/?(?:think|thinking|analysis|reasoning)\b[^>]*>|\[(?:analysis|thinking|reasoning)\]|(?:^|\n)\s*(?:#{1,6}\s*)?(?:analysis|thinking|reasoning|draft(?: answer| reply)?|final answer)\s*:/i.test(text)
    ||/\b(?:i|we)\s+(?:need to|should|must|will)\s+(?:now\s+)?(?:draft|compose|formulate|craft)\s+(?:a |the |my |our )?(?:final |concise |safe |owner-facing |customer-facing )*(?:answer|reply|response)\b/i.test(text)
    ||/\b(?:i|we)\s+(?:need to|should|must)\s+(?:now\s+)?(?:answer|reply|respond|mention|say|include|avoid)\b/i.test(text)
    ||/\b(?:let['’]s|let me)\s+(?:now\s+)?(?:draft|compose|formulate|craft)\s+(?:a |the )?(?:final |concise |safe )*(?:answer|reply|response)\b/i.test(text)
    ||/(?:^|\n)\s*(?:need to|must|should)\s+(?:produce|give|write|return)\s+(?:a |the |only )?(?:final |concise |safe |owner-facing )*(?:answer|reply|response)\b/i.test(text))
    return 'internal_drafting_narration';
  return null;
}
