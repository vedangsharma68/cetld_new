import {AUTH_CALLBACK_PATH, readEmailAuthLink} from './auth-link.mjs';

// Supabase can fall back to Site URL when a requested redirect is not allowed.
// Keep tokens in the fragment while forwarding public-page arrivals to the app.
const query = new URLSearchParams(location.search);
if (readEmailAuthLink(location) || query.has('code')) {
  location.replace(AUTH_CALLBACK_PATH + location.search + location.hash);
}
