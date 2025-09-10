import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || "";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const supabase = url && service ? createClient(url, service, { auth: { persistSession: false } }) : null;

export function isSupabaseReady(): boolean {
	return Boolean(supabase);
}

