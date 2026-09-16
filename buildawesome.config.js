import { HtmlBasePlugin } from "@awesome.me/buildawesome";
import * as esbuild from "esbuild";
import { renderSamplesTable } from "./lib/render.js";

export default function (eleventyConfig) {
	// Prefixes root-relative URLs in HTML output when built with --pathprefix (e.g. a GitHub Pages project site).
	eleventyConfig.addPlugin(HtmlBasePlugin);

	eleventyConfig.addPassthroughCopy({
		"src/assets": "assets",
		"node_modules/esbuild-wasm/esbuild.wasm": "assets/esbuild.wasm",
		"node_modules/brotli-wasm/pkg.web/brotli_wasm_bg.wasm": "assets/brotli.wasm",
	});

	eleventyConfig.addWatchTarget("client/");
	eleventyConfig.addWatchTarget("lib/");
	eleventyConfig.on("buildawesome.before", async ({ directories }) => {
		await esbuild.build({
			entryPoints: ["client/site.js"],
			outdir: `${directories.output}assets/js`,
			bundle: true,
			splitting: true,
			minify: true,
			format: "esm",
			platform: "browser",
			logLevel: "warning",
		});
	});

	eleventyConfig.addFilter("renderSamplesTable", renderSamplesTable);
	eleventyConfig.addFilter("readableDate", (iso) =>
		new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
	);

	return {
		dir: { input: "src" },
	};
}
