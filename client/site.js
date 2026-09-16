import { applyMode, sortTable } from "./peers.js";

const STORAGE_KEY = "bundlewhys:peers";
const toggle = document.querySelector("[data-peers-toggle]");

try {
	if (localStorage.getItem(STORAGE_KEY) === "exclude") {
		document.documentElement.dataset.peers = "exclude";
	}
} catch {}

if (toggle) {
	toggle.checked = document.documentElement.dataset.peers !== "exclude";
	toggle.closest("[hidden]")?.removeAttribute("hidden");
	toggle.addEventListener("change", () => {
		let mode = toggle.checked ? "include" : "exclude";
		document.documentElement.dataset.peers = mode;
		try {
			localStorage.setItem(STORAGE_KEY, mode);
		} catch {}
		applyMode();
	});
}

for (let table of document.querySelectorAll("table[data-sortable]")) {
	for (let th of table.querySelectorAll("th[data-sort]")) {
		let button = document.createElement("button");
		button.textContent = th.textContent;
		th.replaceChildren(button);
		button.addEventListener("click", () => {
			let direction = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
			table.querySelectorAll("th[aria-sort]").forEach((header) => header.removeAttribute("aria-sort"));
			th.setAttribute("aria-sort", direction);
			sortTable(table);
		});
	}
}

document.querySelector("[data-samples-expand] button")?.addEventListener("click", (event) => {
	let row = event.currentTarget.closest("tr");
	row.closest("table").dataset.expanded = "";
	let next = row.nextElementSibling;
	row.remove();
	next?.querySelector("a")?.focus();
});

applyMode();

if (document.querySelector("[data-lookup]")) {
	import("./lookup.js");
}
