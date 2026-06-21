# MonkeAPI

A small, production-oriented API for Solana Monkey Business Gen2 and Gen3.
It replaces a 0.5–1 MB collection download per lookup with one metadata request
and a canvas-safe image URL.

The service is designed for Railway, but it is ordinary Node.js and can run
anywhere that supports Node 24 or Docker.

## What it provides

| Route | Purpose |
| --- | --- |
| `GET /v1/gen2/:id` | Metadata for one Gen2 token |
| `GET /v1/gen3/:id` | Metadata for one Gen3 token, including sparse 5-digit ids |
| `GET /v1/gen2` | Gen2 count and real id range |
| `GET /v1/gen3` | Gen3 count and real id range |
| `GET /img/:collection/:id.png` | Original art through a CORS-safe cached proxy |
| `GET /cut/:collection/:id.png` | Transparent PNG when a cutout is available |
| `GET /healthz` | Railway liveness check |
| `GET /readyz` | Confirms the token index is populated |
| `GET /docs` | Interactive OpenAPI documentation |

Example token response:

```json
{
  "id": 12677,
  "collection": "gen3",
  "name": "SMB Gen3 #12677",
  "image": "https://your-api.example/img/gen3/12677.png",
  "cutout": null
}
```

Unknown ids return a structured `404`; the server never assumes Gen3 ids are
contiguous.

## Canvas and recording safety

Every proxied image response includes:

```text
Access-Control-Allow-Origin: *
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: public, max-age=31536000, immutable
```

Gen2 `arweave.net` URLs are rewritten to `permagate.io` before the upstream
request. Redirect destinations are checked against an allowlist, and only
bounded raster image responses are accepted.

The browser must still set `crossOrigin` before assigning `src`:

```ts
const image = new Image();
image.crossOrigin = "anonymous";
image.src = metadata.image;
await image.decode();
```

Displaying an image is not enough to validate this path. Before release, test
an actual `canvas.captureStream()` recording in desktop Chrome, the Seeker
WebView, and iOS Safari and confirm that the exported clip is not black.

## Local development

Requirements: Node.js 24 LTS and npm.

```bash
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:3000/docs`.

Useful checks:

```bash
npm run check
```

## Token index

The API loads `data/index.json` once at startup. That keeps lookups O(1), keeps
the deployment simple, and avoids adding a database for immutable collection
metadata.

### Import existing collection JSON

The importer accepts local files or URLs:

```bash
npm run index:import -- \
  --gen2 https://ath.camera/monkegram/data/gen2.json \
  --gen3 https://ath.camera/monkegram/data/gen3.json \
  --skip-invalid
```

Strict validation is the default. `--skip-invalid` reports and omits malformed
legacy records, which is useful for the known empty-image entries in historical
static data.

### Rebuild from Helius DAS

```bash
HELIUS_API_KEY=your-key npm run index:helius
```

The Helius builder fetches both collection mints and continues pagination until
it receives a short page. It deliberately does not trust DAS `total` as a
grand-total value. It also rejects duplicate or unparseable token numbers so a
bad index cannot be deployed quietly.

Commit the generated `data/index.json`; no Helius key is needed at runtime.

## Background-removed cutouts

Cutouts are optional and never block the original image route.

There are two supported paths:

1. Put pre-generated transparent files at
   `data/cutouts/<gen2|gen3>/<id>.png`.
2. Set `CUTOUT_SERVICE_URL` to an HTTP background-removal service. MonkeAPI
   sends the source image bytes in a `POST` and expects `image/png` back. An
   optional bearer token can be set with `CUTOUT_SERVICE_TOKEN`.

Generated cutouts are cached. If neither option exists, token metadata returns
`"cutout": null` and the cutout route returns `404`.

## Deploy to Railway

1. Push this repository to GitHub.
2. Create a Railway service from the repository.
3. Railway will detect the root `Dockerfile` and `railway.json`.
4. Generate a public Railway domain.
5. Set `BASE_URL` to that public URL, without a trailing slash.
6. Check `/healthz`, `/readyz`, and `/docs`.

The service uses Railway's injected `PORT`, handles `SIGTERM`, and has a
zero-downtime healthcheck configured at `/healthz`.

The local image cache is sufficient for a single deployment. If you attach a
Railway Volume, the API automatically uses
`$RAILWAY_VOLUME_MOUNT_PATH/cache`; make sure the container user can write to
the selected mount.

Recommended production variables:

```text
BASE_URL=https://your-domain.example
NODE_ENV=production
RATE_LIMIT_MAX=300
MAX_IMAGE_BYTES=20971520
```

## MonkeGram integration

Use the API first and preserve the existing static JSON as the fallback:

```ts
const MONKE_API = process.env.NEXT_PUBLIC_MONKE_API_URL;

export async function getNFT(
  collection: "gen2" | "gen3",
  id: number,
): Promise<{ name: string; image: string; cutout?: string | null }> {
  if (MONKE_API) {
    try {
      const response = await fetch(`${MONKE_API}/v1/${collection}/${id}`);
      if (response.ok) return await response.json();
      if (response.status === 404) throw new Error("NFT not found");
    } catch {
      // Continue to the current static-JSON fallback.
    }
  }

  const data = await loadLegacyCollection(collection);
  const nft = data[String(id)];
  if (!nft) throw new Error("NFT not found");
  return nft;
}
```

`preloadCollection` can become a no-op or prefetch a known token. Keep the
static files in the app so temporary API outages do not break the static
export or its offline-ish behavior.

## Project structure

```text
src/
  app.ts                 Fastify composition and routes
  config.ts              Validated environment configuration
  domain/                Collection constants, schemas, typed errors
  repositories/          In-memory O(1) token index
  services/              Image proxy/cache and optional cutouts
scripts/
  import-index.ts        Existing JSON importer
  fetch-helius.ts        Reproducible DAS index builder
test/
  app.test.ts            API, sparse-id, CORS, cache and rewrite tests
```

## Security notes

- This is not an open proxy. Every source and redirect host must be allowlisted.
- Subdomains of an allowlisted host are accepted for gateways such as
  Permagate; lookalike sibling domains are not.
- Image responses are size-limited and raster-type checked.
- Errors do not expose production stack traces.
- Public routes are rate-limited.
- Secrets belong in Railway variables, never in `data/index.json`.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

MIT
