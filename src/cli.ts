#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCraftProject } from "./craft/load.ts";
import { mapSchema } from "./map/schema.ts";
import { renderReport } from "./report.ts";

const USAGE = `craft-to-emdash schema <craft-project> [--out <dir>]

  <craft-project>  a Craft CMS 5 project, or its config/project folder
  --out <dir>      where to write seed.json and report.md (default: ./out)

Then check and apply the seed in an EmDash project:
  npx emdash seed out/seed.json --validate
  npx emdash seed out/seed.json --no-content`;

function main(): number {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { out: { type: "string", default: "out" }, help: { type: "boolean", short: "h", default: false } },
	});
	const [command, path] = positionals;
	if (values.help || command !== "schema" || !path) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}

	const result = mapSchema(loadCraftProject(resolve(path)));
	const outDir = resolve(values.out);
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "seed.json"), `${JSON.stringify(result.seed, null, "\t")}\n`);
	writeFileSync(join(outDir, "report.md"), `${renderReport(result)}\n`);

	const decide = result.notes.filter((n) => n.level === "decide").length;
	console.log(
		`${result.seed.collections.length} collections, ${result.seed.blockTypes?.length ?? 0} block types, ` +
			`${result.seed.taxonomies?.length ?? 0} taxonomies -> ${join(outDir, "seed.json")}`,
	);
	console.log(`${decide} item${decide === 1 ? "" : "s"} need a decision: see ${join(outDir, "report.md")}`);
	return 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
