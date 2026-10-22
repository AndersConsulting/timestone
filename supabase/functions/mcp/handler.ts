import { createMcpHandler } from "@modelcontextprotocol/server";
import { pipeline } from "@supabase/middleware";
import { withOAuthProtectedResource, withSupabase } from "@supabase/server";
import { createTimeServer } from "./tools.ts";

// Discovery is public; every MCP request requires a verified user. No service role.
export const handler = pipeline(
  [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
  async (request, { supabase }) => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return Response.json({ error: "Anmeldung erforderlich." }, { status: 401 });
    const mcp = createMcpHandler(() => createTimeServer(supabase, user.id));
    return mcp.fetch(request);
  },
);
