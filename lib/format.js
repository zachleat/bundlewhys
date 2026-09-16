export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	let kilobytes = (bytes / 1024).toFixed(1);
	// Switch at the rounded value so nothing displays as "1024.0 kB".
	return Number(kilobytes) < 1024 ? `${kilobytes} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPercent(value, total) {
	return `${((value / total) * 100).toFixed(1)}%`;
}

export function escape(value) {
	return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function pluralize(count, singular, plural = `${singular}s`) {
	return `${count} ${count === 1 ? singular : plural}`;
}
