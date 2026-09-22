# cetld core backend

Supabase foundation for cetld: Google OAuth client helpers, persistent browser
sessions, tenant workspaces, profiles and business settings, customers,
invoices, payments, and private invoice files.

## Commands

```bash
npm ci
npm test
npm run typecheck
```

Apply migrations in `supabase/migrations` in filename order. Configure the app
with the variables in `.env.example`; never put a service-role key in browser
code. Google must be enabled in Supabase Auth and its callback URL must exactly
match the application's allowlist.

The application should create workspaces through `create_workspace`. Every
business row is bound to an immutable `workspace_id`, and RLS derives access
from `workspace_members`. Invoice files are private and use paths shaped as
`workspace UUID/invoice UUID/random filename`.

