import { exports as resolveExports, imports as resolveImports } from "resolve.exports";
import semver from "semver";
import { gzip } from "pako";

const REGISTRY = "https://registry.npmjs.org";
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".css", ".json"];
const LOADERS = { ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".ts": "ts", ".tsx": "tsx", ".json": "json" };
// Packages whose main entry doesn't reflect their real cost.
const DEFAULT_ENTRIES = { "react-dom": "react-dom/client" };
const BUILTINS = new Set("assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(" "));

// Accepts `name`, `name@range`, `name/subpath`, and `name@range/subpath`.
export function parseInput(input) {
	let match = input.trim().match(/^((?:@[^/@\s]+\/)?[^/@\s]+)(?:@([^/\s]+))?(\/[^\s]*)?$/);
	if (!match) {
		throw new Error(`"${input}" is not a valid package name.`);
	}
	let [, name, range = "latest", subpath = ""] = match;
	name = name.toLowerCase();
	return { name, range, subpath, specifier: name + subpath };
}

function dirname(filePath) {
	return filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
}

function normalize(filePath) {
	let parts = [];
	for (let part of filePath.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return parts.join("/");
}

function extname(filePath) {
	let base = filePath.slice(filePath.lastIndexOf("/") + 1);
	return base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
}

function readString(bytes, start, length) {
	let end = bytes.indexOf(0, start);
	return new TextDecoder().decode(bytes.subarray(start, end === -1 || end > start + length ? start + length : end));
}

function untar(buffer) {
	let files = new Map();
	let longPath;
	for (let offset = 0; offset + 512 <= buffer.length; ) {
		let header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;

		let size = parseInt(readString(header, 124, 12).trim() || "0", 8);
		let type = String.fromCharCode(header[156]);
		let prefix = readString(header, 345, 155);
		let data = buffer.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;

		if (type === "x") {
			longPath = new TextDecoder().decode(data).match(/\d+ path=([^\n]*)\n/)?.[1] ?? longPath;
		} else if (type === "L") {
			longPath = readString(data, 0, size);
		} else {
			if (type === "0" || type === "\0") {
				let name = longPath ?? (prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
				// Tarballs nest files in a top-level folder, usually `package/`.
				files.set(normalize(name).replace(/^[^/]+\//, ""), data);
			}
			longPath = undefined;
		}
	}
	return files;
}

// Downloads are shared across measurements; resolution state is per measurement.
const downloads = new Map();

function cached(url, load) {
	if (!downloads.has(url)) {
		let request = load();
		request.catch(() => downloads.delete(url));
		downloads.set(url, request);
	}
	return downloads.get(url);
}

class Registry {
	#packages = new Map();
	#installed = new Map();

	constructor(onProgress) {
		this.onProgress = onProgress;
	}

	async #fetch(url, options) {
		let response = await fetch(url, options);
		if (!response.ok) {
			throw new Error(response.status === 404 ? `Not found on npm: ${url.replace(`${REGISTRY}/`, "")}` : `npm registry responded with ${response.status} for ${url}`);
		}
		return response;
	}

	getPackument(name) {
		let url = `${REGISTRY}/${name.replace("/", "%2f")}`;
		return cached(url, () => this.#fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" } }).then((response) => response.json()));
	}

	async resolveVersion(name, range = "latest") {
		if (range.startsWith("npm:")) {
			({ name, range } = parseInput(range.slice(4)));
		}
		let validRange = semver.validRange(range);
		let packument = await this.getPackument(name);
		let tags = packument["dist-tags"] ?? {};
		let versions = Object.keys(packument.versions);
		let version = tags[range];
		if (!version && validRange) {
			version = tags.latest && semver.satisfies(tags.latest, validRange) ? tags.latest : semver.maxSatisfying(versions, validRange);
		}
		if (!version && !validRange) {
			version = tags.latest;
		}
		if (!version) {
			throw new Error(`No version of ${name} matches "${range}".`);
		}
		return { name, version, manifest: packument.versions[version] };
	}

	async install(name, range = "latest") {
		if (range.startsWith("npm:")) {
			({ name, range } = parseInput(range.slice(4)));
		}

		// Reuse an installed version when it satisfies the range, like npm’s deduping.
		let validRange = semver.validRange(range);
		let installed = this.#installed.get(name) ?? [];
		let existing = validRange ? installed.find((version) => semver.satisfies(version, validRange)) : installed[0];
		if (existing) {
			return this.#packages.get(`${name}@${existing}`);
		}

		let resolved = await this.resolveVersion(name, range);
		let { version, manifest } = resolved;
		name = resolved.name;

		let key = `${name}@${version}`;
		if (!this.#packages.has(key)) {
			this.#installed.set(name, [...installed, version]);
			let request = (async () => {
				let url = manifest.dist.tarball;
				let files = await cached(url, async () => {
					this.onProgress(`Downloading ${key}`);
					let response = await this.#fetch(url);
					let buffer = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
					return untar(new Uint8Array(buffer));
				});
				let pkg = JSON.parse(new TextDecoder().decode(files.get("package.json")));
				return { key, name, version, pkg, files };
			})();
			this.#packages.set(key, request);
		}
		return this.#packages.get(key);
	}
}

function toVirtualPath(record, file) {
	return `/node_modules/${record.key}/${file}`;
}

function parseVirtualPath(virtualPath) {
	let [, key, file] = virtualPath.match(/^\/node_modules\/((?:@[^/]+\/)?[^/@]+@[^/]+)\/(.*)$/);
	return { key, file };
}

function getBrowserMap(record) {
	if (!record.browserMap) {
		record.browserMap = new Map();
		let { browser } = record.pkg;
		if (browser && typeof browser === "object") {
			for (let [from, to] of Object.entries(browser)) {
				let key = from.startsWith(".") ? normalize(from) : from;
				record.browserMap.set(key, typeof to === "string" && to.startsWith(".") ? normalize(to) : to);
			}
		}
	}
	return record.browserMap;
}

// With `peers` unset, bundles everything and records peer candidates; otherwise marks those peers external.
function createPlugin({ registry, input, peers, found }) {
	let packagesByKey = new Map();
	let empty = (path) => ({ path, namespace: "empty" });

	async function install(name, range) {
		let record = await registry.install(name, range);
		packagesByKey.set(record.key, record);
		return record;
	}

	function findFile(record, target) {
		let { files } = record;
		let candidates = [target, ...EXTENSIONS.map((ext) => target + ext)];
		let nestedPkg = files.get(`${target}/package.json`);
		if (nestedPkg) {
			let { browser, module, main } = JSON.parse(new TextDecoder().decode(nestedPkg));
			let field = [typeof browser === "string" ? browser : undefined, module, main].find(Boolean);
			if (field) {
				let nested = normalize(`${target}/${field}`);
				candidates.push(nested, ...EXTENSIONS.map((ext) => nested + ext));
			}
		}
		candidates.push(...EXTENSIONS.map((ext) => `${target}/index${ext}`));
		return candidates.find((candidate) => files.has(candidate));
	}

	function resolveFile(record, target) {
		let browserMap = getBrowserMap(record);
		let file = findFile(record, normalize(target));
		for (let key of [file, file?.replace(/\.[^./]+$/, ""), normalize(target)]) {
			if (key !== undefined && browserMap.has(key)) {
				let mapped = browserMap.get(key);
				if (mapped === false) return empty(toVirtualPath(record, key));
				file = findFile(record, mapped);
				break;
			}
		}
		if (!file) {
			return { errors: [{ text: `Could not find "${target}" in ${record.key}` }] };
		}
		return { path: toVirtualPath(record, file), namespace: "npm" };
	}

	function resolveEntry(record, subpath, isRequire) {
		let { pkg } = record;
		if (pkg.exports) {
			try {
				let [target] = resolveExports(pkg, `.${subpath}`, { browser: true, require: isRequire, conditions: ["module"] });
				return resolveFile(record, target);
			} catch (error) {
				return { errors: [{ text: `${record.key}: ${error.message}` }] };
			}
		}
		if (subpath) {
			return resolveFile(record, subpath.slice(1));
		}
		let field = [typeof pkg.browser === "string" ? pkg.browser : undefined, pkg.module, pkg.main].find(Boolean);
		return resolveFile(record, field ?? "index");
	}

	return {
		name: "npm-registry",
		setup(build) {
			build.onResolve({ filter: /.*/ }, async (args) => {
				if (args.kind === "entry-point") {
					return { path: args.path, namespace: "entry" };
				}

				let importer = args.namespace === "npm" ? parseVirtualPath(args.importer) : undefined;
				let record = importer && packagesByKey.get(importer.key);
				let isRequire = args.kind === "require-call" || args.kind === "require-resolve";
				let specifier = args.path;

				if (record && specifier.startsWith("#")) {
					try {
						let [target] = resolveImports(record.pkg, specifier, { browser: true, require: isRequire, conditions: ["module"] });
						return target.startsWith(".") ? resolveFile(record, target) : resolveBare(target);
					} catch (error) {
						return { errors: [{ text: `${record.key}: ${error.message}` }] };
					}
				}

				if (specifier.startsWith(".") || specifier.startsWith("/")) {
					if (!record) return { errors: [{ text: `Could not resolve "${specifier}"` }] };
					return resolveFile(record, `${dirname(importer.file)}/${specifier}`);
				}

				if (record) {
					let browserMap = getBrowserMap(record);
					if (browserMap.has(specifier)) {
						let mapped = browserMap.get(specifier);
						if (mapped === false) return empty(specifier);
						if (mapped.startsWith(".")) return resolveFile(record, mapped);
						specifier = mapped;
					}
				}

				return resolveBare(specifier);

				async function resolveBare(specifier) {
					let bareName = specifier.replace(/^node:/, "").split("/")[0];
					if (specifier.startsWith("node:") || BUILTINS.has(bareName)) {
						return { errors: [{ text: `${record?.key ?? input.name} imports the Node.js built-in "${specifier}", which isn’t available in browsers.` }] };
					}

					let { name, subpath } = parseInput(specifier);
					try {
						let target;
						if (!record) {
							target = await install(name, input.range);
						} else if (record.name === name) {
							target = record;
						} else {
							let { dependencies, peerDependencies, optionalDependencies } = record.pkg;
							if (peers?.has(name)) {
								return { path: specifier, external: true };
							}
							if (dependencies?.[name] || optionalDependencies?.[name]) {
								found?.regular.add(name);
							} else if (peerDependencies?.[name] && name !== input.name) {
								found?.peers.add(name);
							}
							let range = dependencies?.[name] ?? peerDependencies?.[name] ?? optionalDependencies?.[name];
							target = await install(name, range);
						}
						return resolveEntry(target, subpath, isRequire);
					} catch (error) {
						return { errors: [{ text: error.message }] };
					}
				}
			});

			build.onLoad({ filter: /.*/, namespace: "entry" }, () => ({ contents: input.code, loader: "js" }));

			build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));

			build.onLoad({ filter: /.*/, namespace: "npm" }, (args) => {
				let { key, file } = parseVirtualPath(args.path);
				return { contents: packagesByKey.get(key).files.get(file), loader: LOADERS[extname(file)] ?? "empty" };
			});
		},
	};
}

async function bundle(esbuild, plugin, minify) {
	let result = await esbuild.build({
		entryPoints: ["entry"],
		outdir: "out",
		bundle: true,
		minify,
		write: false,
		metafile: true,
		format: "esm",
		platform: "browser",
		logLevel: "silent",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: [plugin],
	});
	let [key, meta] = Object.entries(result.metafile.outputs).find(([key]) => key.endsWith(".js"));
	let file = result.outputFiles.find((file) => file.path.endsWith(key));
	return { contents: file.contents, meta, metafile: result.metafile };
}

async function measureVariant({ esbuild, brotli, onProgress, registry, input, peers, found }) {
	let plugin = createPlugin({ registry, input, peers, found });
	let raw = await bundle(esbuild, plugin, false);
	onProgress(peers ? "Minifying without peer dependencies" : "Minifying");
	let min = await bundle(esbuild, plugin, true);

	let breakdown = {};
	for (let [path, { bytesInOutput }] of Object.entries(min.meta.inputs)) {
		let owner = path.match(/\/node_modules\/((?:@[^/]+\/)?[^/@]+)@/)?.[1];
		if (owner && bytesInOutput > 0) {
			breakdown[owner] = (breakdown[owner] ?? 0) + bytesInOutput;
		}
	}

	onProgress("Compressing");
	let sizes = async ({ contents }) => ({
		size: contents.byteLength,
		gzip: gzip(contents, { level: 9 }).byteLength,
		brotli: (await brotli(contents)).byteLength,
	});

	return {
		unminified: await sizes(raw),
		minified: await sizes(min),
		breakdown: Object.entries(breakdown)
			.map(([name, bytes]) => ({ name, bytes }))
			.sort((a, b) => b.bytes - a.bytes),
	};
}

// Sums unpacked sizes across the dependency tree from registry metadata, without downloading tarballs.
async function measureInstall(registry, input, includePeers) {
	let sizes = new Map();
	async function walk(name, range) {
		let resolved = await registry.resolveVersion(name, range);
		let key = `${resolved.name}@${resolved.version}`;
		let { manifest } = resolved;
		if (sizes.has(key)) return;
		sizes.set(key, manifest.dist?.unpackedSize ?? 0);

		let dependencies = { ...manifest.dependencies };
		if (includePeers) {
			for (let [peer, peerRange] of Object.entries(manifest.peerDependencies ?? {})) {
				if (!manifest.peerDependenciesMeta?.[peer]?.optional) dependencies[peer] ??= peerRange;
			}
		}
		await Promise.all(Object.entries(dependencies).map(([dependency, dependencyRange]) => walk(dependency, dependencyRange)));
	}
	await walk(input.name, input.range);
	return { size: [...sizes.values()].reduce((total, size) => total + size, 0), packages: sizes.size };
}

function isIdentifier(name) {
	return /^[A-Za-z_$][\w$]*$/.test(name);
}

function entryCode(entry, imports) {
	let specifier = JSON.stringify(entry);
	if (!imports) {
		// Referencing the namespace object keeps every export, so this is the cost of the whole package.
		return `import * as pkg from ${specifier};\nconsole.log(pkg);\n`;
	}
	let bindings = imports.map((name, index) => `${isIdentifier(name) ? name : JSON.stringify(name)} as _${index}`);
	return `import { ${bindings.join(", ")} } from ${specifier};\nconsole.log(${imports.map((_, index) => `_${index}`).join(", ")});\n`;
}

async function listExports({ esbuild, registry, input }) {
	let specifier = JSON.stringify(input.entry);
	let build = async (code) => {
		let { meta, metafile } = await bundle(esbuild, createPlugin({ registry, input: { ...input, code } }), false);
		return { meta, metafile };
	};
	let result;
	try {
		result = await build(`export * from ${specifier};\nexport { default } from ${specifier};\n`);
	} catch {
		result = await build(`export * from ${specifier};\n`);
	}
	let target = Object.entries(result.metafile.inputs).find(([path]) => path.startsWith("entry:"))?.[1].imports.find((entry) => !entry.external)?.path;
	let names = [...result.meta.exports].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
	return { format: result.metafile.inputs[target]?.format === "cjs" ? "cjs" : "esm", names };
}

function listEntryPoints(record) {
	let { exports } = record.pkg;
	if (!exports || typeof exports !== "object" || !Object.keys(exports).some((key) => key.startsWith("."))) {
		return [];
	}
	return Object.keys(exports)
		.filter((key) => key.startsWith("./") && !key.includes("*") && !/\.(json|css|d\.ts)$/.test(key))
		.map((key) => record.name + key.slice(1));
}

// Returns sizes both with (`include`) and without (`exclude`) peer dependencies bundled.
// Pass `imports` to measure only those named exports, or `analyze` to also list exports and entry points.
export async function measure(rawInput, { esbuild, brotli, onProgress = () => {}, imports, analyze = false }) {
	let input = parseInput(rawInput);
	input.entry = input.subpath ? input.specifier : (DEFAULT_ENTRIES[input.name] ?? input.specifier);
	input.code = entryCode(input.entry, imports?.length ? imports : undefined);
	let registry = new Registry(onProgress);
	let options = { esbuild, brotli, onProgress, registry, input };

	try {
		let found = { peers: new Set(), regular: new Set() };
		let include = await measureVariant({ ...options, found });
		// Something else in the tree depending on a package directly means it gets bundled either way.
		let peers = new Set([...found.peers].filter((name) => !found.regular.has(name)));
		let exclude = peers.size ? await measureVariant({ ...options, peers }) : include;
		for (let entry of include.breakdown) {
			entry.peer = peers.has(entry.name);
		}
		if (!imports?.length) {
			onProgress("Calculating install size");
			[include.install, exclude.install] = await Promise.all([measureInstall(registry, input, true), measureInstall(registry, input, false)]);
			if (include === exclude) include.install = exclude.install;
		}
		let record = await registry.install(input.name, input.range);
		let { version, description } = record.pkg;

		let analysis = {};
		if (analyze) {
			onProgress("Listing exports");
			analysis = {
				exports: await listExports({ esbuild, registry, input }),
				entryPoints: listEntryPoints(record).filter((entryPoint) => entryPoint !== input.entry),
			};
		}

		return {
			specifier: input.specifier,
			entry: input.entry,
			name: input.name,
			version,
			description,
			imports: imports?.length ? imports : undefined,
			peerDependencies: [...peers].sort(),
			include,
			exclude,
			...analysis,
			measuredAt: new Date().toISOString(),
		};
	} catch (error) {
		let message = (error.errors?.map((e) => e.text).join("\n") || error.message).replace(/npm:\/node_modules\//g, "");
		return { specifier: input.specifier, name: input.name, error: message, measuredAt: new Date().toISOString() };
	}
}
