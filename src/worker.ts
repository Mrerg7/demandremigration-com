const CANONICAL_ORIGIN = "https://demandremigration.com";
const CANONICAL_HOST = "demandremigration.com";
const NOT_FOUND_PATHS = new Set(["/404", "/404/", "/404.html"]);
const FAVICON_ICO_PATH = "/favicon.ico";
const FAVICON_SVG_PATH = "/favicon.svg";

/** Root and nested /index(.html) aliases Assets can soft-serve as duplicate HTML. */
const INDEX_HTML_SUFFIX = /\/index\.html\/?$/i;
const INDEX_ALIAS_SUFFIX = /\/index\/?$/i;

/** Tracking / session params that create duplicate URL variants in Search Console. */
const STRIP_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

const FALLBACK_404_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="robots" content="noindex"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>404 — demandremigration.com</title></head><body><h1>404</h1><p>This page is not part of the record.</p><p><a href="/">Back to demandremigration.com</a></p></body></html>`;

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function redirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: location, ...SECURITY_HEADERS },
  });
}

function notFoundHeaders(): HeadersInit {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  };
}

function collapseIndexAliases(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, "/") || "/";
  if (INDEX_HTML_SUFFIX.test(path)) {
    path = path.replace(INDEX_HTML_SUFFIX, "/");
  }
  // /index and /index/ soft-serve index.html under force-trailing-slash —
  // collapse them so GSC does not see duplicate URLs without a chosen canonical.
  if (INDEX_ALIAS_SUFFIX.test(path)) {
    path = path.replace(INDEX_ALIAS_SUFFIX, "/");
  }
  if (path.length === 0) path = "/";
  return path;
}

function stripTrackingParams(searchParams: URLSearchParams): boolean {
  let changed = false;
  for (const key of [...searchParams.keys()]) {
    if (STRIP_QUERY_PARAMS.has(key.toLowerCase())) {
      searchParams.delete(key);
      changed = true;
    }
  }
  return changed;
}

function needsTrailingSlash(pathname: string): boolean {
  return (
    !NOT_FOUND_PATHS.has(pathname) &&
    pathname !== "/" &&
    pathname !== FAVICON_ICO_PATH &&
    !pathname.endsWith("/") &&
    !/\.\w+$/.test(pathname)
  );
}

type CanonicalPlan = {
  /** Fully normalized canonical URL (apex https, no index.html, trailing slash). */
  canonical: URL;
  hostChanged: boolean;
  pathChanged: boolean;
  slashAdded: boolean;
  queryChanged: boolean;
};

function planCanonical(request: Request): CanonicalPlan {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const isSiteHost = hostname === CANONICAL_HOST || hostname === `www.${CANONICAL_HOST}`;
  // Only force https/apex for the real site hosts — leave localhost and
  // workers.dev previews alone so local/dev URLs stay usable.
  const hostChanged =
    hostname === `www.${CANONICAL_HOST}` || (isSiteHost && url.protocol === "http:");

  const origin = isSiteHost ? CANONICAL_ORIGIN : url.origin;
  // Build from origin alone — `new URL("//" + search, origin)` throws (protocol-relative).
  const canonical = new URL(origin);
  const beforePath = url.pathname || "/";
  canonical.pathname = collapseIndexAliases(beforePath);
  canonical.search = url.search;

  // Common sitemap aliases → the Astro sitemap index Google already knows.
  if (canonical.pathname === "/sitemap.xml" || canonical.pathname === "/sitemap.xml/") {
    canonical.pathname = "/sitemap-index.xml";
  }

  const pathChanged = canonical.pathname !== beforePath;

  let slashAdded = false;
  if (needsTrailingSlash(canonical.pathname)) {
    canonical.pathname += "/";
    slashAdded = true;
  }

  let queryChanged = stripTrackingParams(canonical.searchParams);
  // Drop a bare "?" so /? is not treated as a distinct URL.
  if (url.href.endsWith("?") && canonical.searchParams.toString() === "") {
    canonical.search = "";
    queryChanged = true;
  }

  return { canonical, hostChanged, pathChanged, slashAdded, queryChanged };
}

async function assetExists(env: Env, absoluteUrl: string, request: Request): Promise<boolean> {
  try {
    const response = await env.ASSETS.fetch(new Request(absoluteUrl, request));
    return response.status !== 404;
  } catch {
    // On probe failure, allow the redirect so real pages stay reachable.
    return true;
  }
}

async function notFoundResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    // Use a clean GET so POST/body on the original request cannot break ASSETS or throw.
    const assetResponse = await env.ASSETS.fetch(
      new Request(new URL("/404.html", url.origin), { method: "GET" }),
    );
    if (assetResponse.body) {
      return new Response(assetResponse.body, {
        status: 404,
        headers: notFoundHeaders(),
      });
    }
  } catch {
    // Fall through to an inline 404 so missing assets never become a Worker 5xx.
  }
  return new Response(FALLBACK_404_HTML, {
    status: 404,
    headers: notFoundHeaders(),
  });
}

async function faviconResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const assetResponse = await env.ASSETS.fetch(
    new Request(new URL(FAVICON_SVG_PATH, url.origin), { method: "GET" }),
  );
  const headers = new Headers(assetResponse.headers);
  headers.set("Content-Type", "image/svg+xml; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=86400");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

/**
 * Single-page site: HTML always declares https://demandremigration.com/ as canonical.
 * Mirror that in the Link header so Google never sees a conflicting signal
 * ("Duplicate, Google chose different canonical than user").
 */
function withCanonicalLink(response: Response): Response {
  if (response.status !== 200) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.set("Link", `<${CANONICAL_ORIGIN}/>; rel="canonical"`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (NOT_FOUND_PATHS.has(url.pathname)) {
        return notFoundResponse(request, env);
      }

      // Serve favicon.ico as the SVG without a redirect (stops GSC "Page with redirect").
      if (url.pathname === FAVICON_ICO_PATH || url.pathname === `${FAVICON_ICO_PATH}/`) {
        const plan = planCanonical(request);
        if (plan.hostChanged) {
          return redirect(new URL(FAVICON_ICO_PATH, CANONICAL_ORIGIN).toString());
        }
        return faviconResponse(request, env);
      }

      const plan = planCanonical(request);
      const needsRedirect =
        plan.hostChanged || plan.pathChanged || plan.slashAdded || plan.queryChanged;

      if (needsRedirect) {
        // Never 301 into a 404 — unknown paths return noindex 404 in one response
        // (avoids GSC "Page with redirect" on dead paths like /home → /home/ → 404).
        if (plan.slashAdded && plan.canonical.pathname !== "/") {
          const exists = await assetExists(env, plan.canonical.toString(), request);
          if (!exists) {
            return notFoundResponse(request, env);
          }
        }
        return redirect(plan.canonical.toString());
      }

      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) return notFoundResponse(request, env);
      return withCanonicalLink(assetResponse);
    } catch {
      // Unhandled Worker exceptions surface as CF 5xx in Search Console.
      return new Response("Service temporarily unavailable", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "60",
          ...SECURITY_HEADERS,
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;
