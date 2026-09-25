const result = document.getElementById('oauth-result');
if (result) {
  const decode = (value) => {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return decodeURIComponent(Array.from(atob(padded), (character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  };
  let payload = null;
  try { payload = JSON.parse(decode(result.dataset.payload)); } catch { payload = null; }
  const origin = decode(result.dataset.origin);
  if (window.opener && payload && origin) {
    try { window.opener.postMessage(payload, origin); } catch { /* The return link remains available. */ }
    if (result.dataset.autoClose === 'true') setTimeout(() => window.close(), 450);
  } else {
    setTimeout(() => location.replace('/?page=Connections'), 900);
  }
}
