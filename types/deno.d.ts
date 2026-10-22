// Minimal host declarations for Node-based type checking; Supabase runs Deno.
declare namespace Deno {
  namespace env { function get(name: string): string | undefined; }
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}
