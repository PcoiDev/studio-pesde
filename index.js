const express = require("express");
const tar = require("tar-stream");
const zlib = require("zlib");
const unzipper = require("unzipper");
const { Readable } = require("stream");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;
const PESDE_REGISTRY = "https://registry.pesde.daimond113.com";
const WALLY_REGISTRY = "https://api.wally.run";
const WALLY_HEADERS = { "Wally-Version": "0.3.2" };
const TARGET = "roblox"; 

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
	const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
	return match ? match[1] : null;
}

function getPesdeEntrypoint(files) {
	const manifest = files.find(f => f.path === "pesde.toml" || f.path.endsWith("/pesde.toml"));
	if (!manifest) return null;
	return parseTOMLValue(manifest.content, "lib");
}

function getWallyEntrypoint(files) {
	const projectFile = files.find(f => f.path === "default.project.json" || f.path.endsWith("/default.project.json"));
	if (!projectFile) return null;

	try {
		const project = JSON.parse(projectFile.content);
		const srcPath = project?.tree?.["$path"];
		if (!srcPath) return null;

		const normalized = srcPath.replace(/\\/g, "/").replace(/\/$/, "");
		const candidates = [`${normalized}/init.luau`, `${normalized}/init.lua`];

		for (const candidate of candidates) {
			if (files.find(f => f.path === candidate || f.path.endsWith("/" + candidate))) {
				return candidate;
			}
		}

		return null;
	} catch {
		return null;
	}
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
 *   query (string) - Search term used to find packages.
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
	const { query } = req.query;
	if (!query) return res.status(400).json({ error: "Missing query parameter" });

	const [pesdeRes, wallyRes] = await Promise.allSettled([
		fetch(`${PESDE_REGISTRY}/v1/search?query=${encodeURIComponent(query)}`).then(r => r.json()),
		fetch(`${WALLY_REGISTRY}/v1/package-search?query=${encodeURIComponent(query)}`, { headers: WALLY_HEADERS }).then(r => r.json()),
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
 *   query (string) - Search term used to find Pesde packages.
 *
 * Description:
 * Proxies the search request to the Pesde registry and returns the raw
 * search results.
 *
 * Response:
 * JSON response returned directly by the Pesde registry search endpoint.
 */
app.get("/pesde/search", async (req, res) => {
	const { query } = req.query;
	if (!query) return res.status(400).json({ error: "Missing query parameter" });

	const response = await fetch(`${PESDE_REGISTRY}/v1/search?query=${encodeURIComponent(query)}`);
	const data = await response.json();
	res.json(data);
});

/**
 * Search packages in the Wally registry.
 *
 * Route: GET /wally/search
 * Query Params:
 *   query (string) - Search term used to find Wally packages.
 *
 * Description:
 * Proxies the search request to the Wally registry using the required
 * Wally headers and returns the raw search results.
 *
 * Response:
 * JSON response returned directly by the Wally registry search endpoint.
 */
app.get("/wally/search", async (req, res) => {
	const { query } = req.query;
	if (!query) return res.status(400).json({ error: "Missing query parameter" });

	const response = await fetch(`${WALLY_REGISTRY}/v1/package-search?query=${encodeURIComponent(query)}`, { headers: WALLY_HEADERS });
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
 *   version (string) - Package version to download.
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
	const { version } = req.query;

	if (!version) return res.status(400).json({ error: "Missing version query parameter" });

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
		res.json({ package: `${scope}/${name}`, version, target: TARGET, entrypoint, files });
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
 *   version (string) - Package version to download.
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
	const { version } = req.query;

	if (!version) return res.status(400).json({ error: "Missing version query parameter" });

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
	console.log(`pesde proxy running on port ${PORT}`);
});