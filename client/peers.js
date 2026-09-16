import { formatBytes } from "../lib/format.js";

export function getMode() {
	return document.documentElement.dataset.peers === "exclude" ? "exclude" : "include";
}

function cellValue(cell, mode) {
	return cell?.dataset[mode] ?? cell?.querySelector("[data-include]")?.dataset[mode] ?? cell?.dataset.sortValue ?? "";
}

export function sortTable(table) {
	let th = table.querySelector("th[aria-sort]");
	if (!th) return;
	let index = [...th.parentElement.children].indexOf(th);
	let mode = getMode();
	let direction = th.getAttribute("aria-sort") === "ascending" ? 1 : -1;
	let value = (row) => cellValue(row.children[index], mode);
	let expand = table.querySelector("[data-samples-expand]");
	let rows = [...table.tBodies[0].children].filter((row) => row !== expand).sort((a, b) => {
		if (th.dataset.sort === "text") return value(a).localeCompare(value(b)) * direction;
		// Rows without a value (failed builds) always sort last.
		let [x, y] = [value(a), value(b)].map((v) => (v === "" ? NaN : Number(v)));
		if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) - Number.isNaN(y);
		return (x - y) * direction;
	});
	table.tBodies[0].append(...rows);
	if (expand) rows[0].after(expand);
}

export function applyMode(scope = document) {
	let mode = getMode();
	let suffix = mode === "include" ? "Include" : "Exclude";
	for (let el of scope.querySelectorAll("[data-include]")) {
		let value = el.dataset[mode];
		el.textContent = value === "" || el.dataset.format === "count" ? value : formatBytes(Number(value));
	}
	for (let el of scope.querySelectorAll("[data-text-include]")) {
		el.textContent = el.dataset[`text${suffix}`];
	}
	for (let el of scope.querySelectorAll("[data-bar-include]")) {
		el.style.setProperty("--size", el.dataset[`bar${suffix}`] || "0%");
	}
	for (let table of scope.querySelectorAll("table[data-sortable]")) {
		sortTable(table);
	}
}
