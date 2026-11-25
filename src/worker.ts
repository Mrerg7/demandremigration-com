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
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; upgrade-insecure-requests",
};

const LINK_HEADER = [
  `<${CANONICAL_ORIGIN}/>; rel="canonical"`,
  `</llms.txt>; rel="describedby"; type="text/markdown"; title="LLM site index"`,
  `</index.md>; rel="alternate"; type="text/markdown"; title="Markdown version of this page"`,
  `</sitemap-index.xml>; rel="sitemap"; type="application/xml"`,
  `</.well-known/security.txt>; rel="security"; type="text/plain"`,
].join(", ");

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

function markdownQuality(accept: string): { markdown: number; html: number } {
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(",")) {
    const [rawType, ...params] = part.trim().toLowerCase().split(";");
    const type = rawType.trim();
    const qParam = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const quality = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(quality)) continue;
    if (type === "text/markdown") markdown = quality;
    if (type === "text/html" || type === "application/xhtml+xml") html = Math.max(html, quality);
  }
  return { markdown, html };
}

function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const { markdown, html } = markdownQuality(accept);
  return markdown > 0 && markdown >= html;
}

function withVaryAccept(headers: Headers): void {
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Accept");
  else if (!vary.toLowerCase().split(",").some((part) => part.trim() === "accept")) {
    headers.set("Vary", `${vary}, Accept`);
  }
}

/**
 * Single-page site: HTML always declares https://demandremigration.com/ as canonical.
 * The Link header mirrors that and also advertises the markdown and sitemap.
 */
function withCanonicalLink(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const contentType = headers.get("content-type") ?? "";
  if (response.status === 200 && contentType.includes("text/html")) {
    headers.set("Link", LINK_HEADER);
    withVaryAccept(headers);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function markdownResponse(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const markdown = await env.ASSETS.fetch(
    new Request(new URL("/index.md", url.origin), { method: "GET" }),
  );
  if (!markdown.ok || !markdown.body) return null;
  const headers = new Headers(markdown.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("X-Robots-Tag", "noindex");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("Link", LINK_HEADER);
  withVaryAccept(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(request.method === "HEAD" ? null : markdown.body, {
    status: 200,
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

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname === "/" &&
        wantsMarkdown(request.headers.get("Accept"))
      ) {
        const markdown = await markdownResponse(request, env);
        if (markdown) return markdown;
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
