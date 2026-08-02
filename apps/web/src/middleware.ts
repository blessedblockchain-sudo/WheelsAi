import { NextResponse, type NextRequest } from "next/server";

/**
 * Logged-out guard for the dashboard (INT-X2).
 *
 * Before this file existed there was NO middleware at all: a logged-out
 * visit to /dashboard rendered the full chrome with zeroed data — every
 * API call 401'd behind the scenes. Now it redirects to /login with a
 * validated `next` param so the user lands back where they aimed.
 *
 * The check is presence-only: `wheelsai_token` is a signed httpOnly
 * cookie minted by the API (setAuthCookie, middleware/auth.ts) — the
 * SIGNATURE is only verifiable server-side by the API, so an invalid or
 * expired cookie still reaches the page and fails on its first API call
 * exactly as before. This guard fixes the zeroed-chrome experience, not
 * authz (which stays with the API).
 *
 * Cookie visibility: cookies are host-scoped, not port-scoped, so the
 * API's cookie on localhost:4000 is visible here on localhost:3000. In
 * production the API must set the cookie with a Domain covering the web
 * app's host (or be served same-host under a path) for this middleware
 * to see it — deployment-checklist item, not a code change here.
 */
export function middleware(request: NextRequest) {
  const token = request.cookies.get("wheelsai_token");
  if (token?.value) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
