const PAGES = new Set(['Overview', 'Assistant', 'Business records', 'Invoices', 'Conversations', 'Payments', 'Connections', 'Settings', 'Onboarding']);
const key = userId => `cetld.workspace-page:${userId}`;

export function readWorkspacePage(storage, userId) {
  if (!userId) return 'Overview';
  try {
    const page = storage?.getItem(key(userId));
    return PAGES.has(page) ? page : 'Overview';
  } catch {
    return 'Overview';
  }
}

export function saveWorkspacePage(storage, userId, page) {
  if (!userId || !PAGES.has(page)) return;
  try { storage?.setItem(key(userId), page); } catch {}
}
