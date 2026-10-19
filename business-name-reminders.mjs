// Shared owner-facing copy; counts come from the scoped database snapshot.
export function businessNameReminderNotice(count, {saved=false}={}) {
  if (!Number.isSafeInteger(count) || count <= 0) return '';
  return `${count} approved reminder${count === 1 ? '' : 's'} ${saved ? (count === 1 ? 'is' : 'are') : 'will be'} paused until re-approved in the Conversations tab.`;
}

export function appendBusinessNameReminderNotice(answer, notice) {
  return notice && !answer.includes(notice) ? `${answer}\n\n${notice}` : answer;
}

export async function businessNameChangeImpact(client, workspaceId, businessName) {
  const {data, error} = await client.rpc('business_name_change_impact', {
    p_workspace_id: workspaceId, p_business_name: businessName,
  });
  if (error) throw error;
  if (!data || !Number.isSafeInteger(data.pausedReminderCount) || data.pausedReminderCount < 0
      || typeof data.updatedAt !== 'string') throw Error('Could not check affected reminders. Refresh and try again.');
  return data;
}

export function businessNameReviewNotice(invoice) {
  const metadata = invoice.metadata || invoice;
  return invoice.followup_state === 'draft' && metadata.followup_review_reason === 'business_name_change'
    ? 'Needs re-approval after business name change. Re-approve this reminder in the Conversations tab.' : '';
}
