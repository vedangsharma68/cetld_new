/**
 * Persistence helpers for the authenticated user's profile and workspace
 * business settings.  The caller supplies an already-authenticated Supabase
 * client; these helpers deliberately never use a service-role client.
 */

export type SupabaseLike = {
  from(table: string): any;
  storage: { from(bucket: string): any };
};

export type Profile = {
  user_id: string;
  full_name?: string | null;
  avatar_url?: string | null;
  [key: string]: unknown;
};

export type BusinessSettings = {
  workspace_id: string;
  business_name?: string | null;
  currency?: string | null;
  timezone?: string | null;
  [key: string]: unknown;
};

export type ProfilePatch = Partial<Omit<Profile, "user_id">>;
export type BusinessSettingsPatch = Partial<Omit<BusinessSettings, "workspace_id">>;

function throwIfError(response: { error?: unknown }): void {
  if (response?.error) throw response.error;
}

/** Load the profile belonging to the current authenticated user. */
export async function getProfile(client: SupabaseLike, userId: string): Promise<Profile | null> {
  const response = await client.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  throwIfError(response);
  return response.data ?? null;
}

/**
 * Persist profile fields. The profile primary key is the auth user id. RLS
 * remains responsible for ensuring that the caller can only write their row.
 */
export async function updateProfile(
  client: SupabaseLike,
  userId: string,
  patch: ProfilePatch,
): Promise<Profile> {
  const response = await client
    .from("profiles")
    .upsert({ ...patch, user_id: userId }, { onConflict: "user_id" })
    .select("*")
    .single();
  throwIfError(response);
  return response.data as Profile;
}

export async function getBusinessSettings(
  client: SupabaseLike,
  workspaceId: string,
): Promise<BusinessSettings | null> {
  const response = await client
    .from("workspace_settings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  throwIfError(response);
  return response.data ?? null;
}

/** Persist workspace-level business settings. Workspace membership is checked by RLS. */
export async function updateBusinessSettings(
  client: SupabaseLike,
  workspaceId: string,
  patch: BusinessSettingsPatch,
): Promise<BusinessSettings> {
  const response = await client
    .from("workspace_settings")
    .upsert({ ...patch, workspace_id: workspaceId }, { onConflict: "workspace_id" })
    .select("*")
    .single();
  throwIfError(response);
  return response.data as BusinessSettings;
}
