# demandremigration.com

Sister site to [demandremigration.com](https://demandremigration.com/), [demandingremigration.com](https://demandingremigration.com/), [nozabiha.com](https://nozabiha.com/), [nozabihahalal.com](https://nozabihahalal.com/), [islamophobe.me](https://islamophobe.me/), and [industrialterrorism.com](https://industrialterrorism.com/).

Static Astro site on Cloudflare Workers static assets. Free plan. Not deployed until you run the deploy script.

## Deploy

```bash
npm install
npm run deploy
```

Then attach the custom domain `demandremigration.com` to the worker `demandremigration-com`. If that worker name is already taken on the account, rename it in wrangler.toml before the first deploy.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

## Search Console / canonicals

`www.demandremigration.com` and `http` on the apex redirect to `https://demandremigration.com/` in one hop where the Worker sees the request. `/index`, `/index/`, `/index.html`, and double-slash paths also 301 to `/` so Cloudflare Assets cannot soft-serve a duplicate homepage.

HTML responses always send `Link: <https://demandremigration.com/>; rel="canonical"` to match the page `<link rel="canonical">` (avoids GSC: “Duplicate, Google chose different canonical than user”).

Trailing-slash redirects only fire when the destination asset exists — unknown paths like `/home` return a hard `404` with `noindex` instead of `/home` → `/home/` → 404 (avoids GSC: “Page with redirect”). `/favicon.ico` is served as the SVG with `200` (no redirect). `/sitemap.xml` 301s to `/sitemap-index.xml`. Tracking query params (`utm_*`, `gclid`, `fbclid`, …) are stripped with a 301.

workers.dev previews are disabled (`workers_dev = false`) so a second host cannot compete for the canonical.
