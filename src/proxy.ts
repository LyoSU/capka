import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/setup",
  // Shared chats are viewable without a session. The page itself enforces the
  // per-chat visibility gate (anyone-with-link vs signed-in-only vs private),
  // so the middleware must let anonymous visitors reach it instead of bouncing
  // them to /login.
  "/share",
  "/api/auth",
  "/api/setup",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/" ||
    PUBLIC_PATHS.some((p) => p !== "/" && pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname === "/manifest.json" ||
    pathname === "/sw.js"
  ) {
    return NextResponse.next();
  }

  // better-auth prefixes the cookie with `__Secure-` whenever secure cookies are
  // on (any HTTPS deployment), and uses the bare name over plain HTTP. Check both
  // — looking only for the bare name 401s every request on an HTTPS deploy.
  const sessionToken =
    request.cookies.get("better-auth.session_token") ??
    request.cookies.get("__Secure-better-auth.session_token");
  if (!sessionToken) {
    // API clients want a status code, not an HTML login page.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
