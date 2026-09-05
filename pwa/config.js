// BVL Registration — deployment configuration.
//
// Both values below are safe to publish. The publishable key can ONLY insert a
// registration and read the centre list; row level security stops it reading,
// changing or deleting any child's record. (See the anon policies in
// supabase/migrations/20260902000001_pwa_intake.sql.)
//
// NEVER put the secret / service_role key here.

window.BVL_CONFIG = {
  SUPABASE_URL: "https://wknlcxquihvjcuneffps.supabase.co",        // e.g. https://wknlcxquihvjcuneffps.supabase.co
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_sfdDXF9ov9wfjkOAQXx7kw_4nfg_Zuk",  // e.g. sb_publishable_...
};
