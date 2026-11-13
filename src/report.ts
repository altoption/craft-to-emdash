import type { Note, SchemaResult } from "./map/schema.ts";

/** A Markdown report of what was converted and what a person still has to decide. */
export function renderReport({ seed, notes }: SchemaResult): string {
	const fieldCount =
		seed.collections.reduce((n, c) => n + c.fields.length, 0) +
		(seed.blockTypes ?? []).reduce((n, b) => n + (b.versions[0]?.fields.length ?? 0), 0);
	const decide = notes.filter((n) => n.level === "decide");
	const info = notes.filter((n) => n.level === "info");

	const section = (title: string, items: Note[]): string[] => {
		if (items.length === 0) return [];
		const byCode = new Map<string, Note[]>();
		for (const n of items) byCode.set(n.code, [...(byCode.get(n.code) ?? []), n]);
		const lines = [`## ${title}`, ""];
		for (const [code, group] of byCode) {
			lines.push(`### ${code} (${group.length})`, "");
			for (const n of group) lines.push(`- **${n.where}**: ${n.message}`);
			lines.push("");
		}
		return lines;
	};

	return [
		"# Craft to EmDash: schema report",
		"",
		`- Collections: ${seed.collections.length}`,
		`- Block types: ${seed.blockTypes?.length ?? 0}`,
		`- Taxonomies: ${seed.taxonomies?.length ?? 0}`,
		`- Fields: ${fieldCount}`,
		`- Default locale: ${seed.defaultLocale}`,
		`- Needs a decision: ${decide.length}`,
		"",
		...section("Needs a decision", decide),
		...section("For your information", info),
	].join("\n");
}
