// This server has no auth layer (see B5 task notes / apps/web instrumentation.ts)
// and the /api/db routes give read access to the whole local SQLite database.
// The only thing keeping that safe is binding to loopback only. If something
// (a shell env, a process manager, a container entrypoint) sets HOST to
// anything routable, fail loudly at startup instead of silently listening on
// a reachable interface.
const SAFE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Loopback binding stops the network, not other tabs in the same browser: any
 * page can fire a "simple" cross-origin POST at 127.0.0.1. Routes with side
 * effects (approving a delete, opening a terminal, spending Claude usage) call
 * this to refuse requests a browser marks as coming from another site.
 * Requests with no Origin/Sec-Fetch-Site (curl, scripts) are allowed; a browser
 * always sends them on cross-origin POSTs.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get("host");
  } catch {
    return true;
  }
}

export function assertSafeHost(host: string | undefined = process.env.HOST): void {
  if (host === undefined || host === "") return;
  if (SAFE_HOSTS.has(host)) return;

  throw new Error(
    `Refusing to start: HOST is set to "${host}", which is not 127.0.0.1/localhost. ` +
      `This app has no auth layer and must only bind to loopback — it must never be ` +
      `reachable from the network. Unset HOST or set it to 127.0.0.1.`
  );
}
