const express = require("express");
const tar = require("tar-stream");
const zlib = require("zlib");
const unzipper = require("unzipper");
const { Readable } = require("stream");
const fetch = require("node-fetch");
const semver = require("semver");

const app = express();
const PORT = process.env.PORT || 3000;
const PESDE_REGISTRY = "https://registry.pesde.daimond113.com";
const WALLY_REGISTRY = "https://api.wally.run";
const WALLY_HEADERS = { "Wally-Version": "0.3.2" };
const TARGET = "roblox";

function getPublicBaseUrl(port) {
	const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
	if (railwayDomain) return `https://${railwayDomain}`;

	const staticUrl = process.env.RAILWAY_STATIC_URL;
	if (staticUrl) {
		const withProtocol = /^https?:\/\//i.test(staticUrl) ? staticUrl : `https://${staticUrl}`;
		return withProtocol.replace(/\/$/, "");
	}

	return `http://localhost:${port}`;
}

async function extractTar(buffer) {
	const files = [];

	let tarBuffer;
	try {
		tarBuffer = zlib.gunzipSync(buffer);
	} catch {
		tarBuffer = buffer;
	}

	await new Promise((resolve, reject) => {
		const extract = tar.extract();

		extract.on("entry", (header, stream, next) => {
			if (header.type !== "file") {
				stream.resume();
				return next();
			}

			const chunks = [];
			stream.on("data", (chunk) => chunks.push(chunk));
			stream.on("end", () => {
				const content = Buffer.concat(chunks).toString("utf8");
				files.push({ path: header.name, content });
				next();
			});
			stream.on("error", reject);
		});

		extract.on("finish", resolve);
		extract.on("error", reject);

		Readable.from(tarBuffer).pipe(extract);
	});

	return files;
}

async function extractZip(buffer) {
	const files = [];

	const directory = await unzipper.Open.buffer(buffer);
	for (const file of directory.files) {
		if (file.type === "Directory") continue;
		const content = await file.buffer();
		files.push({ path: file.path, content: content.toString("utf8") });
	}

	return files;
}

function parseTOMLValue(toml, key) {
	const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
	return match ? match[1] : null;
}

function getPesdeEntrypoint(files) {
	const manifest = files.find(f => f.path === "pesde.toml" || f.path.endsWith("/pesde.toml"));
	if (!manifest) return null;
	return parseTOMLValue(manifest.content, "lib");
}

function getPesdeDependencies(files) {
	const manifest = files.find(f => f.path === "pesde.toml" || f.path.endsWith("/pesde.toml"));
	if (!manifest) return [];

	const dependencies = [];
	const seen = new Set();

	const pushDependency = (name, version) => {
		const cleanName = String(name || "").replace(/^"|"$/g, "").trim();
		if (!cleanName) return;

		const key = `${cleanName}:${version || ""}`;
		if (seen.has(key)) return;
		seen.add(key);

		dependencies.push({ name: cleanName, version: version || null });
	};

	const getVersionFromValue = (value) => {
		if (!value) return null;

		const quoted = value.match(/^"([^"]+)"/);
		if (quoted) return quoted[1];

		const inlineVersion = value.match(/\bversion\s*=\s*"([^"]+)"/);
		if (inlineVersion) return inlineVersion[1];

		return null;
	};

	const body = manifest.content;

	const directDependenciesMatch = body.match(/^\[dependencies\]\s*([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/m);
	if (directDependenciesMatch) {
		const lines = directDependenciesMatch[1].split(/\r?\n/);
		for (const rawLine of lines) {
			const line = rawLine.split("#")[0].trim();
			if (!line) continue;

			const entry = line.match(/^([A-Za-z0-9_.\-"/]+)\s*=\s*(.+)$/);
			if (!entry) continue;

			const [, name, value] = entry;
			pushDependency(name, getVersionFromValue(value.trim()));
		}
	}

	const nestedDependencyRegex = /^\[dependencies\.([^\]]+)\]\s*([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/gm;
	let nestedMatch;
	while ((nestedMatch = nestedDependencyRegex.exec(body)) !== null) {
		const [, alias, sectionBody] = nestedMatch;
		const name = parseTOMLValue(sectionBody, "name") || alias;
		const version = parseTOMLValue(sectionBody, "version");
		pushDependency(name, version);
	}

	return dependencies;
}

function getWallyEntrypoint(files) {
	const fallbackEntrypoint = (() => {
		const initCandidates = ["init.luau", "init.lua"];

		for (const candidate of initCandidates) {
			const found = files.find(f => f.path === candidate || f.path.endsWith("/" + candidate));
			if (found) return found.path;
		}

		return null;
	})();

	const projectFile = files.find(f => f.path === "default.project.json" || f.path.endsWith("/default.project.json"));
	if (!projectFile) return fallbackEntrypoint;

	try {
		const project = JSON.parse(projectFile.content);
		const srcPath = project?.tree?.["$path"];
		if (!srcPath) return fallbackEntrypoint;

		const normalized = srcPath.replace(/\\/g, "/").replace(/\/$/, "");
		const candidates = [`${normalized}/init.luau`, `${normalized}/init.lua`];

		for (const candidate of candidates) {
			if (files.find(f => f.path === candidate || f.path.endsWith("/" + candidate))) {
				return candidate;
			}
		}

		return fallbackEntrypoint;
	} catch {
		return fallbackEntrypoint;
	}
}

function getLatestVersion(versions) {
	if (!Array.isArray(versions) || versions.length === 0) return null;

	const valid = versions.filter(v => semver.valid(v));
	if (valid.length > 0) return semver.rsort(valid)[0];

	return versions.slice().sort().reverse()[0] || null;
}

function resolveVersionFromList(versions, requestedVersion) {
	if (!requestedVersion) return getLatestVersion(versions);
	if (requestedVersion.startsWith("^^") || requestedVersion === "^0.0.0") {
		const latest = getLatestVersion(versions);
		if (latest) return latest;

		const exactFallback = requestedVersion.replace(/^\^\^/, "");
		return versions.includes(exactFallback) ? exactFallback : null;
	}

	if (requestedVersion.startsWith("^")) {
		const matched = semver.maxSatisfying(versions, requestedVersion, {
			includePrerelease: false,
			loose: true,
		});
		if (matched) return matched;

		const exactFallback = requestedVersion.slice(1);
		return versions.includes(exactFallback) ? exactFallback : null;
	}

	return versions.includes(requestedVersion) ? requestedVersion : null;
}

async function resolvePesdeVersion(scope, name, requestedVersion) {
	const packageId = encodeURIComponent(`${scope}/${name}`);
	const metadataUrl = `${PESDE_REGISTRY}/v1/packages/${packageId}`;

	let response;
	try {
		response = await fetch(metadataUrl);
	} catch (err) {
		throw { status: 502, error: "Failed to reach pesde registry", details: err.message };
	}

	if (!response.ok) {
		throw { status: response.status, error: `Registry returned ${response.status}`, url: metadataUrl };
	}

	const metadata = await response.json();
	const versions = Object.entries(metadata?.versions || {})
		.filter(([, value]) => Boolean(value?.targets?.[TARGET]))
		.map(([version]) => version);

	return resolveVersionFromList(versions, requestedVersion);
}

async function resolveWallyVersion(scope, name, requestedVersion) {
	const metadataUrl = `${WALLY_REGISTRY}/v1/package-metadata/${scope}/${name}`;

	let response;
	try {
		response = await fetch(metadataUrl, { headers: WALLY_HEADERS });
	} catch (err) {
		throw { status: 502, error: "Failed to reach Wally registry", details: err.message };
	}

	if (!response.ok) {
		throw { status: response.status, error: `Wally registry returned ${response.status}`, url: metadataUrl };
	}

	const metadata = await response.json();
	const versions = [...new Set((metadata?.versions || []).map(v => v?.package?.version).filter(Boolean))];

	return resolveVersionFromList(versions, requestedVersion);
}

/**
 * Health check endpoint.
 *
 * Route: GET /health
 * Description:
 * Returns a simple status response used to verify that the proxy server
 * is running and reachable.
 *
 * Response:
 * {
 *   ok: true
 * }
 */
app.get("/health", (req, res) => {
	res.json({ ok: true });
});

/**
 * Unified package search across Pesde and Wally registries.
 *
 * Route: GET /search
 * Query Params:
 *   q (string) - Search term used to find packages.
 *
 * Description:
 * Performs a search request on both the Pesde registry and the Wally registry
 * concurrently. The results from both registries are returned in a single
 * response object. If one registry fails, the other result is still returned.
 *
 * Response:
 * {
 *   pesde: <pesde search result | error>,
 *   wally: <wally search result | error>
 * }
 */
app.get("/search", async (req, res) => {
	const q = String(req.query.q ?? req.query.query ?? "").trim();
	if (!q) return res.status(400).json({ error: "Missing q query parameter" });

	const [pesdeRes, wallyRes] = await Promise.allSettled([
		fetch(`${PESDE_REGISTRY}/v1/search?query=${encodeURIComponent(q)}`).then(r => r.json()),
		fetch(`${WALLY_REGISTRY}/v1/package-search?query=${encodeURIComponent(q)}`, { headers: WALLY_HEADERS }).then(r => r.json()),
	]);

	res.json({
		pesde: pesdeRes.status === "fulfilled" ? pesdeRes.value : { error: "pesde search failed" },
		wally: wallyRes.status === "fulfilled" ? wallyRes.value : { error: "wally search failed" },
	});
});

/**
 * Search packages in the Pesde registry.
 *
 * Route: GET /pesde/search
 * Query Params:
 *   q (string) - Search term used to find Pesde packages.
 *
 * Description:
 * Proxies the search request to the Pesde registry and returns the raw
 * search results.
 *
 * Response:
 * JSON response returned directly by the Pesde registry search endpoint.
 */
app.get("/pesde/search", async (req, res) => {
	const q = String(req.query.q ?? req.query.query ?? "").trim();
	if (!q) return res.status(400).json({ error: "Missing q query parameter" });

	const response = await fetch(`${PESDE_REGISTRY}/v1/search?query=${encodeURIComponent(q)}`);
	const data = await response.json();
	res.json(data);
});

/**
 * Search packages in the Wally registry.
 *
 * Route: GET /wally/search
 * Query Params:
 *   q (string) - Search term used to find Wally packages.
 *
 * Description:
 * Proxies the search request to the Wally registry using the required
 * Wally headers and returns the raw search results.
 *
 * Response:
 * JSON response returned directly by the Wally registry search endpoint.
 */
app.get("/wally/search", async (req, res) => {
	const q = String(req.query.q ?? req.query.query ?? "").trim();
	if (!q) return res.status(400).json({ error: "Missing q query parameter" });

	const response = await fetch(`${WALLY_REGISTRY}/v1/package-search?query=${encodeURIComponent(q)}`, { headers: WALLY_HEADERS });
	const data = await response.json();
	res.json(data);
});

/**
 * Retrieve and extract a Pesde package archive.
 *
 * Route: GET /pesde/:scope/:name
 *
 * Path Params:
 *   scope (string) - Package namespace.
 *   name  (string) - Package name.
 *
 * Query Params:
 *   v (string, optional) - Exact package version, or ^0.0.0 to force latest.
 *
 * Description:
 * Downloads the specified package archive from the Pesde registry for
 * the Roblox target. The archive is extracted server-side and the list
 * of files is returned along with the detected entrypoint defined in
 * the `pesde.toml` manifest (`lib` field).
 *
 * Response:
 * {
 *   package: "scope/name",
 *   version: "<version>",
 *   target: "roblox",
 *   entrypoint: "<path | null>",
 *   files: [
 *     { path: "<file path>", content: "<file content>" }
 *   ]
 * }
 */
app.get("/pesde/:scope/:name", async (req, res) => {
	const { scope, name } = req.params;
	const requestedVersion = String(req.query.v ?? req.query.version ?? "").trim() || null;

	let version;
	try {
		version = await resolvePesdeVersion(scope, name, requestedVersion);
	} catch (err) {
		return res.status(err.status || 500).json({ error: err.error || "Failed to resolve version", details: err.details, url: err.url });
	}

	if (!version) {
		return res.status(404).json({
			error: requestedVersion
				? `No version found for '${requestedVersion}'`
				: "No versions found for this package",
		});
	}

	const packageId = encodeURIComponent(`${scope}/${name}`);
	const archiveUrl = `${PESDE_REGISTRY}/v1/packages/${packageId}/${version}/${TARGET}/archive`;

	let archiveRes;
	try {
		archiveRes = await fetch(archiveUrl);
	} catch (err) {
		return res.status(502).json({ error: "Failed to reach pesde registry", details: err.message });
	}

	if (!archiveRes.ok) {
		return res.status(archiveRes.status).json({
			error: `Registry returned ${archiveRes.status}`,
			url: archiveUrl,
		});
	}

	try {
		const files = await extractTar(await archiveRes.buffer());
		const entrypoint = getPesdeEntrypoint(files);
		const dependencies = getPesdeDependencies(files);
		res.json({ package: `${scope}/${name}`, version, target: TARGET, entrypoint, dependencies, files });
	} catch (err) {
		res.status(500).json({ error: "Failed to extract archive", details: err.message });
	}
});

/**
 * Retrieve and extract a Wally package archive.
 *
 * Route: GET /wally/:scope/:name
 *
 * Path Params:
 *   scope (string) - Package namespace.
 *   name  (string) - Package name.
 *
 * Query Params:
 *   v (string, optional) - Exact package version, or ^0.0.0 to force latest.
 *
 * Description:
 * Downloads the package archive from the Wally registry, extracts its
 * contents, and attempts to determine the module entrypoint based on the
 * `default.project.json` configuration. The entrypoint is typically an
 * `init.lua` or `init.luau` file located inside the source path defined
 * in the Rojo project tree.
 *
 * Response:
 * {
 *   package: "scope/name",
 *   version: "<version>",
 *   target: "roblox",
 *   entrypoint: "<path | null>",
 *   files: [
 *     { path: "<file path>", content: "<file content>" }
 *   ]
 * }
 */
app.get("/wally/:scope/:name", async (req, res) => {
	const { scope, name } = req.params;
	const requestedVersion = String(req.query.v ?? req.query.version ?? "").trim() || null;

	let version;
	try {
		version = await resolveWallyVersion(scope, name, requestedVersion);
	} catch (err) {
		return res.status(err.status || 500).json({ error: err.error || "Failed to resolve version", details: err.details, url: err.url });
	}

	if (!version) {
		return res.status(404).json({
			error: requestedVersion
				? `No version found for '${requestedVersion}'`
				: "No versions found for this package",
		});
	}

	const archiveUrl = `${WALLY_REGISTRY}/v1/package-contents/${scope}/${name}/${version}`;

	let archiveRes;
	try {
		archiveRes = await fetch(archiveUrl, { headers: WALLY_HEADERS });
	} catch (err) {
		return res.status(502).json({ error: "Failed to reach Wally registry", details: err.message });
	}

	if (!archiveRes.ok) {
		return res.status(archiveRes.status).json({
			error: `Wally registry returned ${archiveRes.status}`,
			url: archiveUrl,
		});
	}

	try {
		const files = await extractZip(await archiveRes.buffer());
		const entrypoint = getWallyEntrypoint(files);
		res.json({ package: `${scope}/${name}`, version, target: TARGET, entrypoint, files });
	} catch (err) {
		res.status(500).json({ error: "Failed to extract archive", details: err.message });
	}
});

app.listen(PORT, () => {
	const baseUrl = getPublicBaseUrl(PORT);
	console.log(`Running on ${baseUrl}`);
});
