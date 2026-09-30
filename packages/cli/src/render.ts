/** TTY rendering helpers (humans only; stdout here is fine because JSON mode never runs these). */

export function meetingRange(
	days: string,
	start: string | null,
	end: string | null,
): string {
	const range = end ? `-${end}` : "";
	return `${days} ${start ?? "TBA"}${range}`;
}

export function table(rows: string[][]): string {
	const widths: number[] = [];
	for (const r of rows) {
		r.forEach((c, i) => {
			widths[i] = Math.max(widths[i] ?? 0, c.length);
		});
	}
	return rows
		.map((r) =>
			r
				.map((c, i) => c.padEnd(widths[i]))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}
