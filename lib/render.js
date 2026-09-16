import { escape, formatBytes, formatPercent, pluralize } from "./format.js";

// Markup carries values for both peer dependency modes; client/peers.js swaps between them.
function values(include, exclude = "") {
	return ` data-include="${include}" data-exclude="${exclude}"`;
}

function card(result, label, key) {
	let include = result.include[key];
	let exclude = result.exclude[key];
	return `<div class="card">
		<dt>${label}</dt>
		<dd class="size"${values(include.size, exclude.size)}>${formatBytes(include.size)}</dd>
		<dd class="compressed">gzip <span${values(include.gzip, exclude.gzip)}>${formatBytes(include.gzip)}</span></dd>
		<dd class="compressed">brotli <span${values(include.brotli, exclude.brotli)}>${formatBytes(include.brotli)}</span></dd>
	</div>`;
}

function compressed(gzipInclude, gzipExclude, brotliInclude, brotliExclude, prefix = "") {
	return `<span class="compressed-line">gzip ${prefix}<span${values(gzipInclude, gzipExclude)}>${formatBytes(gzipInclude)}</span></span>
		<span class="compressed-line">brotli ${prefix}<span${values(brotliInclude, brotliExclude)}>${formatBytes(brotliInclude)}</span></span>`;
}

function installCard(result) {
	let include = result.include.install;
	let exclude = result.exclude.install;
	if (!include) return "";
	return `<div class="card">
		<dt>Install size</dt>
		<dd class="size"${values(include.size, exclude.size)}>${formatBytes(include.size)}</dd>
		<dd class="compressed" data-text-include="${pluralize(include.packages, "package")}" data-text-exclude="${pluralize(exclude.packages, "package")}">${pluralize(include.packages, "package")}</dd>
	</div>`;
}

function composition(result, heading = `<h2 class="section">Composition</h2>`) {
	let excluded = new Map(result.exclude.breakdown.map((entry) => [entry.name, entry.bytes]));
	// Shares are of package code only, leaving out the bundler’s own helper code.
	let total = {
		include: result.include.breakdown.reduce((sum, entry) => sum + entry.bytes, 0),
		exclude: result.exclude.breakdown.reduce((sum, entry) => sum + entry.bytes, 0),
	};
	let largest = { include: result.include.breakdown[0]?.bytes ?? 1, exclude: result.exclude.breakdown[0]?.bytes ?? 1 };
	let rows = result.include.breakdown.map(({ name, bytes, peer }) => {
		let excludeBytes = excluded.get(name) ?? "";
		let share = { include: formatPercent(bytes, total.include), exclude: excludeBytes && formatPercent(excludeBytes, total.exclude) };
		let bar = { include: formatPercent(bytes, largest.include), exclude: excludeBytes && formatPercent(excludeBytes, largest.exclude) };
		let estimate = (mode, amount, key) => (amount === "" ? "" : Math.round((amount / total[mode]) * result[mode].minified[key]));
		return `<tr${peer ? " data-peer" : ""}>
			<td>${escape(name)}${peer ? ' <span class="tag">peer</span>' : ""}</td>
			<td class="num"${values(bytes, excludeBytes)}>${formatBytes(bytes)}</td>
			<td class="num secondary">${compressed(estimate("include", bytes, "gzip"), estimate("exclude", excludeBytes, "gzip"), estimate("include", bytes, "brotli"), estimate("exclude", excludeBytes, "brotli"), "≈ ")}</td>
			<td class="num bar-cell" style="--size: ${bar.include}" data-bar-include="${bar.include}" data-bar-exclude="${bar.exclude}" data-text-include="${share.include}" data-text-exclude="${share.exclude}">${share.include}</td>
		</tr>`;
	});
	return `${heading}
	<p class="hint">Minified bytes contributed by each package in the bundle. Compressed sizes are estimated from each package’s share.</p>
	<table>
		<thead><tr><th scope="col">Package</th><th scope="col" class="num">Minified</th><th scope="col" class="num secondary">Compressed</th><th scope="col" class="num">Share</th></tr></thead>
		<tbody>${rows.join("")}</tbody>
	</table>`;
}

export function renderResult(result, heading = "h2") {
	let title = `<${heading}>${escape(result.specifier)}${result.version ? ` <span class="version">${escape(result.version)}</span>` : ""}</${heading}>`;
	if (result.error) {
		return `${title}<p class="error">This package failed to bundle for the browser:</p><pre>${escape(result.error)}</pre>`;
	}
	return `${title}
	${result.description ? `<p>${escape(result.description)}</p>` : ""}
	${result.entry !== result.specifier ? `<p class="hint">Measured using <code>${escape(result.entry)}</code>.</p>` : ""}
	${result.peerDependencies.length ? `<p class="hint">Peer dependencies: ${result.peerDependencies.map((name) => `<code>${escape(name)}</code>`).join(", ")}</p>` : ""}
	<p><a href="https://www.npmjs.com/package/${escape(result.name)}">View on npm</a></p>
	<dl class="cards">${card(result, "Bundle size unminified", "unminified")}${card(result, "Bundle size minified", "minified")}${installCard(result)}</dl>
	${composition(result)}
	${entryPoints(result)}
	${exportsPicker(result)}`;
}

const ENTRY_POINT_LIMIT = 12;

function entryPoints(result) {
	if (!result.entryPoints?.length) return "";
	// Rendered in the browser, outside the HTML base plugin, so keep this relative to the page.
	let link = (entryPoint) => `<li><a href="?package=${encodeURIComponent(entryPoint)}" data-lookup-shortcut><code>${escape(entryPoint)}</code></a></li>`;
	let visible = result.entryPoints.slice(0, ENTRY_POINT_LIMIT);
	let hidden = result.entryPoints.slice(ENTRY_POINT_LIMIT);
	return `<h2 class="section">Entry points</h2>
	<p class="hint">A narrower entry point can be much smaller than the whole package.</p>
	<ul class="entry-points">${visible.map(link).join("")}</ul>
	${hidden.length ? `<details><summary>${hidden.length} more</summary><ul class="entry-points">${hidden.map(link).join("")}</ul></details>` : ""}`;
}

function exportsPicker(result) {
	let { exports } = result;
	if (!exports?.names.length) return "";
	if (exports.format === "cjs") {
		return `<h2 class="section">Exports</h2>
		<p class="hint">This entry point is CommonJS, so bundlers can’t remove the exports you don’t use. Try an ESM alternative${result.entryPoints?.length ? " or one of the entry points above" : ""}.</p>`;
	}
	let selected = new Set(result.selectedImports ?? []);
	return `<h2 class="section">Exports</h2>
	<p class="hint">Select the exports you use to see what’s left after tree shaking.</p>
	<form class="exports" data-exports-form>
		<input type="search" placeholder="Filter ${exports.names.length} exports" aria-label="Filter exports" data-exports-filter>
		<fieldset class="exports-list">
			<legend class="visually-hidden">Exports</legend>
			${exports.names.map((name) => `<label><input type="checkbox" name="export" value="${escape(name)}"${selected.has(name) ? " checked" : ""}> <code>${escape(name)}</code></label>`).join("")}
		</fieldset>
		<div class="exports-actions">
			<button type="submit">Measure selected</button>
			<button type="button" class="secondary-button" data-exports-clear>Clear</button>
			<span class="hint" data-exports-count>${selected.size} selected</span>
		</div>
	</form>
	<div data-selection-result></div>`;
}

function savings(selection, full, key) {
	let percent = Math.round((1 - selection[key].minified.size / full[key].minified.size) * 100);
	return percent > 0 ? `${percent}% smaller than importing everything` : "No smaller than importing everything";
}

export function renderSelection(selection, full) {
	let names = selection.imports.map((name) => `<code>${escape(name)}</code>`).join(", ");
	if (selection.error) {
		return `<h3>Importing ${names}</h3><p class="error">Failed to bundle:</p><pre>${escape(selection.error)}</pre>`;
	}
	let text = { include: savings(selection, full, "include"), exclude: savings(selection, full, "exclude") };
	return `<h3>Importing ${names}</h3>
	<p class="savings" data-text-include="${text.include}" data-text-exclude="${text.exclude}">${text.include}</p>
	<dl class="cards">${card(selection, "Bundle size unminified", "unminified")}${card(selection, "Bundle size minified", "minified")}</dl>
	<details><summary>Composition</summary>${composition(selection, "")}</details>`;
}

export function renderSamplesTable(packages) {
	let measured = packages.filter((pkg) => !pkg.error);
	let largest = {
		include: Math.max(...measured.map((pkg) => pkg.include.minified.size)),
		exclude: Math.max(...measured.map((pkg) => pkg.exclude.minified.size)),
	};
	let sorted = [...measured].sort((a, b) => a.include.minified.size - b.include.minified.size).concat(packages.filter((pkg) => pkg.error));

	let rows = sorted.map((pkg) => {
		let link = `<td data-sort-value="${escape(pkg.specifier)}"><a href="/?package=${encodeURIComponent(pkg.specifier)}" data-lookup-shortcut>${escape(pkg.specifier)}</a></td>`;
		if (pkg.error) {
			return `<tr>${link}<td colspan="4" class="error">Failed to bundle</td></tr>`;
		}
		let { include, exclude } = pkg;
		let bar = { include: formatPercent(include.minified.size, largest.include), exclude: formatPercent(exclude.minified.size, largest.exclude) };
		return `<tr>
			${link}
			<td>${escape(pkg.version)}</td>
			<td class="num bar-cell" style="--size: ${bar.include}" data-bar-include="${bar.include}" data-bar-exclude="${bar.exclude}"><span${values(include.minified.size, exclude.minified.size)}>${formatBytes(include.minified.size)}</span></td>
			<td class="num secondary">${compressed(include.minified.gzip, exclude.minified.gzip, include.minified.brotli, exclude.minified.brotli)}</td>
			<td class="num" data-format="count"${values(include.breakdown.length, exclude.breakdown.length)}>${include.breakdown.length}</td>
		</tr>`;
	});

	let collapsed = sorted.length - 2;
	if (collapsed > 0) {
		rows.splice(1, 0, `<tr class="samples-expand" data-samples-expand><td colspan="5"><button type="button">Show ${collapsed} more samples</button></td></tr>`);
	}
	return `<table data-sortable data-samples>
		<thead>
			<tr>
				<th scope="col" data-sort="text">Package</th>
				<th scope="col">Version</th>
				<th scope="col" data-sort="number" class="num" aria-sort="ascending">Minified</th>
				<th scope="col" data-sort="number" class="num secondary">Compressed</th>
				<th scope="col" data-sort="number" class="num">Packages</th>
			</tr>
		</thead>
		<tbody>${rows.join("")}</tbody>
	</table>`;
}
