"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.isSupabaseReady = isSupabaseReady;
const supabase_js_1 = require("@supabase/supabase-js");
const url = process.env.SUPABASE_URL || "";
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
exports.supabase = url && service ? (0, supabase_js_1.createClient)(url, service, { auth: { persistSession: false } }) : null;
function isSupabaseReady() {
    return Boolean(exports.supabase);
}
//# sourceMappingURL=supabase.js.map