# Auth contract

Create one browser client with `createBrowserAuthClient`, start Google OAuth
with an exact allowlisted callback using `signInWithGoogle`, and call
`exchangeOAuthCode` on that callback route. Sessions use PKCE, persistent
browser storage, automatic token refresh, and explicit server verification by
`restoreSession` before user data is trusted.

In Supabase Auth, enable Google, enter the Google client ID and secret, and add
the deployed callback URL to the redirect allowlist. The Google console must
allow Supabase's provider callback URL shown by the Supabase dashboard.
