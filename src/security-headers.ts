/** Baseline security headers for Worker responses (SEC-09). */

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://esm.sh",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", CSP);
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
