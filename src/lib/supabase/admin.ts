import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Service-role Supabase client for privileged admin-management operations
 * (creating/deleting auth users, setting passwords, changing roles). It bypasses
 * RLS, so it must ONLY be used from server actions that have already verified the
 * caller's permissions. Never import this from a client component.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
