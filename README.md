# pesde-proxy

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Simple HTTP proxy for Roblox package tooling.

This service sits between your app and package registries so everything is easier to consume from one place.

I'm building this as the backend for a Studio plugin, so packages can be searched and installed directly inside Roblox Studio.

---

## Why this exists

Working with both registries usually means handling different endpoints, archive formats, and metadata rules.

`pesde-proxy` normalizes that so your client can stay small and predictable.

---

## API

Base URL: `http://localhost:3000`

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `GET /search?query=<term>`

Searches both registries in parallel.

Returns:

```json
{
  "pesde": { "...": "..." },
  "wally": { "...": "..." }
}
```

If one registry fails, the other one is still returned.

### `GET /pesde/search?query=<term>`

Pass-through to Pesde search endpoint.

### `GET /wally/search?query=<term>`

Pass-through to Wally search endpoint (`Wally-Version: 0.3.2` header is applied).

### `GET /pesde/:scope/:name?version=<version>`

Downloads a Pesde archive for the `roblox` target, extracts files, and returns:

- `package`
- `version`
- `target`
- `entrypoint` (`string | null`)
- `files` (`[{ path, content }]`)

### `GET /wally/:scope/:name?version=<version>`

Downloads a Wally archive, extracts files, and returns:

- `package`
- `version`
- `target`
- `entrypoint` (`string | null`)
- `files` (`[{ path, content }]`)

---

## Quick examples

```bash
curl "http://localhost:3000/health"
curl "http://localhost:3000/search?query=promise"
curl "http://localhost:3000/pesde/lune-org/lune?version=0.8.9"
curl "http://localhost:3000/wally/upliftgames/trove?version=1.1.0"
```

---

## Deploying on Railway

The repo already includes `railway.json`:

- build: `NIXPACKS`
- start command: `node index.js`
- restart policy: `ON_FAILURE`

---

## License

MIT. See `LICENSE`.
