import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

export const dynamic = "force-dynamic";

/** Cookie-only authorization subrequest for the public dashboard ingress. */
export async function GET(request: Request) {
  const authenticated = await isDashboardSessionAuthenticated(request);
  return new Response(null, {
    status: authenticated ? 204 : 401,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

export const HEAD = GET;
