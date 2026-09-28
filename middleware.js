import {next} from '@vercel/functions/middleware';
import {config as supabase} from './config.js';
import {LANDING_SESSION_COOKIE} from './session-cookie.mjs';

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}

export default async function landingAuthRedirect(request) {
  const accessToken = readCookie(request.headers.get('cookie'), LANDING_SESSION_COOKIE);
  if (!accessToken) return next();

  try {
    const response = await fetch(`${supabase.url}/auth/v1/user`, {
      headers: {apikey: supabase.key, authorization: `Bearer ${accessToken}`},
    });
    if (response.ok) return Response.redirect(new URL('/app/', request.url), 307);
  } catch {
    // Authentication outages must not hide the public, crawler-readable page.
  }

  return next();
}

export const config = {matcher: '/'};
