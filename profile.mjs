const firstNonEmpty = (...values) =>
  values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';

const userMetadata = (user) =>
  user && typeof user.user_metadata === 'object' && user.user_metadata !== null
    ? user.user_metadata
    : {};

export function profileFromUser(user) {
  const metadata = userMetadata(user);
  const email = firstNonEmpty(user?.email);
  const emailName = email.split('@')[0].trim();
  const fullName = firstNonEmpty(
    metadata.full_name,
    metadata.fullName,
    metadata.name,
    emailName,
    'Account',
  );
  const businessName = firstNonEmpty(
    metadata.business_name,
    metadata.businessName,
    metadata.company_name,
    metadata.companyName,
  );

  return {
    fullName,
    businessName,
    initials: initialsFor(fullName),
    secondaryLabel: businessName || 'Workspace owner',
  };
}

export function initialsFor(value) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AC';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words.at(-1)[0]}`.toUpperCase();
}
