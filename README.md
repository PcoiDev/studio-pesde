# pesde-proxy

> A tiny Roblox package proxy that makes Pesde and Wally feel like one API.

Simple HTTP proxy for Roblox tooling and Studio plugins.

It sits between your client and both registries, normalizes archive extraction, and returns a consistent response shape (including detected entrypoints).

---

## Why pesde-proxy?

Working with Roblox packages across registries usually means handling different endpoints, different archive formats, and slightly different assumptions in each client flow. `pesde-proxy` removes that friction by exposing one consistent API surface that your plugin or app can rely on.

It gives you unified search across Pesde and Wally, but still keeps direct registry routes when you need raw provider-specific behavior. That means you can start with a simple integration and still keep control for advanced use cases.

For package installation flows, this service downloads archives, extracts files, and returns a predictable response shape with detected entrypoints (including `init.luau` / `init.lua` fallback). This keeps client code small and avoids duplicating extraction and detection logic in multiple places.

Even though this proxy supports both Pesde and Wally, the name stays `pesde-proxy` because Pesde can also consume Wally packages, so the primary workflow still centers around Pesde.

---

## API

### `GET /health`

```ts
type HealthResponse = {
  ok: true;
};
```

```json
{ "ok": true }
```

### `GET /search?q=<term>`

Searches both registries in parallel.

```ts
type UnifiedSearchResponse = {
  pesde: unknown;
  wally: unknown;
};
```

```json
{
  "pesde": { "...": "..." },
  "wally": { "...": "..." }
}
```

If one registry fails, the other one is still returned.

### `GET /pesde/search?q=<term>`

Pass-through to the Pesde search endpoint.

```ts
type PesdeSearchResponse = unknown;
```

### `GET /wally/search?q=<term>`

Pass-through to the Wally search endpoint (`Wally-Version: 0.3.2` header is applied).

```ts
type WallySearchResponse = unknown;
```

### `GET /pesde/:scope/:name?v=<version>`

Downloads a Pesde archive for target `roblox`, extracts files, detects entrypoint, and also detects dependencies from `pesde.toml` with their versions when available.

If `v` is omitted, the latest available version is used automatically. If `v=^x.y.z`, the latest stable version matching that range is used (for example `^0.3.0` resolves to `0.3.0` here). If `v=^^x.y.z`, the latest version is forced even when it is a prerelease.

```ts
type PesdePackageResponse = {
  package: string; // "scope/name"
  version: string;
  target: "roblox";
  entrypoint: string | null;
  dependencies: {
    name: string;
    version: string | null;
  }[];
  files: {
    path: string;
    content: string;
  }[];
};
```

### `GET /wally/:scope/:name?v=<version>`

Downloads a Wally archive, extracts files, and returns:

If `v` is omitted, the latest available version is used automatically. If `v=^x.y.z`, the latest stable version matching that range is used. If `v=^^x.y.z`, the latest version is forced even when it is a prerelease.

```ts
type WallyPackageResponse = {
  package: string; // "scope/name"
  version: string;
  target: "roblox";
  entrypoint: string | null;
  files: {
    path: string;
    content: string;
  }[];
};
```

---

## Quick examples

```bash
curl "http://localhost:3000/health"
curl "http://localhost:3000/search?q=promise"
curl "http://localhost:3000/pesde/alicesaidhi/conch?v=0.3.0"
curl "http://localhost:3000/pesde/alicesaidhi/conch"
# ^x.y.z -> latest stable version matching range
curl "http://localhost:3000/pesde/alicesaidhi/conch?v=^0.3.0"
# ^^x.y.z -> force latest version, including prereleases
curl "http://localhost:3000/pesde/alicesaidhi/conch?v=^^0.3.0"
```

---

## Deploying on Railway

The repo already includes `railway.json`:

- build: `NIXPACKS`
- start command: `node index.js`
- restart policy: `ON_FAILURE`

---
