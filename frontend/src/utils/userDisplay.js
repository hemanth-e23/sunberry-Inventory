const FALLBACK_NAME = 'Unknown user';
const FALLBACK_INITIAL = '?';

export function formatUserName(idOrUsername, userMap) {
  if (!idOrUsername) return FALLBACK_NAME;
  const name = userMap?.[idOrUsername];
  return name && String(name).trim() ? name : FALLBACK_NAME;
}

export function formatUserInitial(idOrUsername, userMap) {
  if (!idOrUsername) return FALLBACK_INITIAL;
  const name = userMap?.[idOrUsername];
  return name && String(name).trim()
    ? String(name).charAt(0).toUpperCase()
    : FALLBACK_INITIAL;
}
