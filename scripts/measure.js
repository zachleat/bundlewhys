import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import * as esbuild from "esbuild";
import { measure } from "../lib/measure.js";

const root = path.resolve(import.meta.dirname, "..");
const outputFile = path.join(root, "src", "_data", "sizes.json");
const CONCURRENCY = 4;

const brotli = (contents) => brotliCompressSync(contents, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });

// Pass specifiers as arguments to re-measure only those, e.g. `npm run measure -- preact vue`.
const allSpecifiers = JSON.parse(await readFile(path.join(root, "packages.json"), "utf8"));
const requested = process.argv.slice(2);
const specifiers = requested.length ? requested : allSpecifiers;

let previous = [];
try {
	previous = JSON.parse(await readFile(outputFile, "utf8")).packages;
} catch {}

let results = new Map(previous.filter((entry) => allSpecifiers.includes(entry.specifier)).map((entry) => [entry.specifier, entry]));
let queue = [...specifiers];

await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		for (let specifier = queue.shift(); specifier; specifier = queue.shift()) {
			let result = await measure(specifier, { esbuild, brotli });
			results.set(specifier, result);
			console.log(result.error ? `✗ ${specifier}: ${result.error.split("\n")[0]}` : `✓ ${specifier}@${result.version} ${result.include.gzip} bytes gzip (${result.exclude.gzip} without peers)`);
		}
	}),
);

let packages = [...results.values()].sort((a, b) => a.specifier.localeCompare(b.specifier));
await writeFile(outputFile, JSON.stringify({ generatedAt: new Date().toISOString(), packages }, null, "\t") + "\n");
console.log(`Wrote ${packages.length} packages to ${path.relative(root, outputFile)}`);
