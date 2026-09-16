import * as esbuild from "esbuild-wasm";
import initBrotli, { compress } from "../node_modules/brotli-wasm/pkg.web/brotli_wasm.js";
import { measure } from "../lib/measure.js";
import { renderResult, renderSelection } from "../lib/render.js";
import { applyMode } from "./peers.js";

const form = document.querySelector("[data-lookup]");
const status = document.querySelector("[data-lookup-status]");
const output = document.querySelector("[data-lookup-result]");
const results = new Map();

let ready;
function setup() {
	// Relative to this script so it works under any path prefix.
	ready ??= Promise.all([
		esbuild.initialize({ wasmURL: new URL("../esbuild.wasm", import.meta.url).href }),
		initBrotli(new URL("../brotli.wasm", import.meta.url).href),
	]);
	return ready;
}

const brotli = (contents) => compress(contents, { quality: 11 });

let currentRun = 0;
async function run(input, imports = []) {
	let runId = ++currentRun;
	let isCurrent = () => runId === currentRun;
	let onProgress = (message) => {
		if (isCurrent()) status.textContent = `${message}…`;
	};

	form.setAttribute("aria-busy", "true");
	try {
		let result = results.get(input);
		if (!result) {
			output.replaceChildren();
			delete output.dataset.input;
			onProgress("Loading esbuild");
			await setup();
			onProgress("Resolving");
			result = await measure(input, { esbuild, brotli, onProgress, analyze: true });
			if (!result.error) results.set(input, result);
		}
		if (!isCurrent()) return;

		// Keep the exports picker (and its filter) in place when only the selection changed.
		if (output.dataset.input !== input || !output.querySelector("[data-selection-result]") || !imports.length) {
			output.innerHTML = renderResult({ ...result, selectedImports: imports });
			output.dataset.input = input;
			applyMode(output);
		}
		status.textContent = "";
		if (imports.length && !result.error) await runSelection(input, imports, isCurrent, onProgress);
	} catch (error) {
		onProgress(error.message);
	} finally {
		if (isCurrent()) form.removeAttribute("aria-busy");
	}
}

async function runSelection(input, imports, isCurrent, onProgress) {
	let target = output.querySelector("[data-selection-result]");
	if (!target) return;
	target.replaceChildren();
	let selection = await measure(input, { esbuild, brotli, onProgress, imports });
	selection.imports = imports;
	if (!isCurrent()) return;
	status.textContent = "";
	target.innerHTML = renderSelection(selection, results.get(input));
	applyMode(target);
}

function reset() {
	currentRun++;
	output.replaceChildren();
	delete output.dataset.input;
	status.textContent = "";
	form.removeAttribute("aria-busy");
}

function navigate(input, imports = []) {
	let url = new URL(location.href);
	url.searchParams.set("package", input);
	if (imports.length) url.searchParams.set("imports", imports.join(","));
	else url.searchParams.delete("imports");
	history.pushState(null, "", url);
	form.elements.package.value = input;
	run(input, imports);
}

// Fires when the search field is emptied, including its clear button and Escape.
form.elements.package.addEventListener("input", () => {
	if (form.elements.package.value.trim()) return;
	reset();
	let url = new URL(location.href);
	if (url.searchParams.has("package")) {
		url.searchParams.delete("package");
		url.searchParams.delete("imports");
		history.pushState(null, "", url);
	}
});

form.addEventListener("submit", (event) => {
	event.preventDefault();
	let input = form.elements.package.value.trim();
	if (input) navigate(input);
});

document.addEventListener("click", (event) => {
	let link = event.target.closest("[data-lookup-shortcut]");
	if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	navigate(new URL(link.href).searchParams.get("package"));
	if (!form.contains(link)) form.scrollIntoView({ behavior: "smooth", block: "start" });
});

const selectedExports = (exportsForm) => [...exportsForm.querySelectorAll("input[name=export]:checked")].map((input) => input.value);

output.addEventListener("submit", (event) => {
	let exportsForm = event.target.closest("[data-exports-form]");
	if (!exportsForm) return;
	event.preventDefault();
	let imports = selectedExports(exportsForm);
	if (imports.length) navigate(new URLSearchParams(location.search).get("package"), imports);
});

output.addEventListener("input", (event) => {
	if (!event.target.matches("[data-exports-filter]")) return;
	let query = event.target.value.trim().toLowerCase();
	for (let label of event.target.form.querySelectorAll(".exports-list label")) {
		label.hidden = !label.textContent.toLowerCase().includes(query);
	}
});

output.addEventListener("change", (event) => {
	let exportsForm = event.target.closest("[data-exports-form]");
	if (exportsForm) exportsForm.querySelector("[data-exports-count]").textContent = `${selectedExports(exportsForm).length} selected`;
});

output.addEventListener("click", (event) => {
	if (!event.target.matches("[data-exports-clear]")) return;
	let exportsForm = event.target.form;
	for (let input of exportsForm.querySelectorAll("input[name=export]")) input.checked = false;
	exportsForm.querySelector("[data-exports-count]").textContent = "0 selected";
	navigate(new URLSearchParams(location.search).get("package"));
});

// Start loading the wasm as soon as someone shows intent to use the form.
form.elements.package.addEventListener("focus", setup, { once: true });

function runFromUrl() {
	let params = new URLSearchParams(location.search);
	let input = params.get("package");
	form.elements.package.value = input ?? "";
	if (input) run(input, params.get("imports")?.split(",").filter(Boolean) ?? []);
	else reset();
}
window.addEventListener("popstate", runFromUrl);
runFromUrl();
