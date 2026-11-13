#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readContent } from "./content/content.ts";
import type { Progress } from "./content/content.ts";
import { consoleExecute, httpExecute, withRetry } from "./content/graphql.ts";
import { loadCraftProject, resolveConfigDir } from "./craft/load.ts";
import { mapSchema } from "./map/schema.ts";
import type { SchemaResult } from "./map/schema.ts";
import { renderReport } from "./report.ts";

const USAGE = `craft-to-emdash <command> <craft-project> [options]

Commands
  schema     Convert the content model. Reads config/project only; needs no running site.
  content    Convert the content model and the content. Reads entries over Craft's GraphQL API.

  <craft-project>   a Craft CMS 5 project, or its config/project folder

Options
  --out <dir>          where to write seed.json and report.md (default: ./out)

Options for content: give one of --craft or --endpoint
  --craft <command>    run queries inside Craft through its console, e.g. "php craft" or "ddev craft".
                       Needs no GraphQL schema or token; reads everything, drafts of status included.
  --endpoint <url>     Craft's GraphQL endpoint, e.g. https://example.com/api.
                       The token is read from the CRAFT_GQL_TOKEN environment variable.
  --sections <a,b>     only these section handles (default: all sections, global sets and redirects)
  --base-url <url>     the site's URL, for assets Craft serves with root-relative URLs
  --page-size <n>      entries per request (default: 100)
  --resume             reuse the sections an interrupted run already finished

Then, in an EmDash project:
  npx emdash seed out/seed.json --validate
  npx emdash seed out/seed.json`;

function write(outDir: string, result: Pick<SchemaResult, "seed" | "notes">): void {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "seed.json"), `${JSON.stringify(result.seed, null, "\t")}\n`);
	writeFileSync(join(outDir, "report.md"), `${renderReport(result)}\n`);
	const decide = result.notes.filter((n) => n.level === "decide").length;
	const entries = Object.values(result.seed.content ?? {}).reduce((n, list) => n + list.length, 0);
	console.error(
		`${result.seed.collections.length} collections, ${result.seed.blockTypes?.length ?? 0} block types, ` +
			`${result.seed.taxonomies?.length ?? 0} taxonomies${result.seed.content ? `, ${entries} entries` : ""} -> ${join(outDir, "seed.json")}`,
	);
	console.error(`${decide} item${decide === 1 ? "" : "s"} need a decision: see ${join(outDir, "report.md")}`);
}

/** One line per section; on a terminal the line updates in place while the section is being read. */
function progressPrinter(): (p: Progress) => void {
	const tty = process.stderr.isTTY;
	return (p) => {
		const label = `[${p.index}/${p.total}] ${p.section}`;
		if (p.state === "reading") {
			if (tty) process.stderr.write(`\r\x1b[K${label}  ${p.fetched}/${p.count}`);
			return;
		}
		const line = `${label}  ${p.fetched} ${p.fetched === 1 ? "entry" : "entries"}${p.state === "resumed" ? " (from the earlier run)" : ""}`;
		process.stderr.write(tty ? `\r\x1b[K${line}\n` : `${line}\n`);
	};
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			out: { type: "string", default: "out" },
			craft: { type: "string" },
			endpoint: { type: "string" },
			sections: { type: "string" },
			"base-url": { type: "string" },
			"page-size": { type: "string", default: "100" },
			resume: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [command, path] = positionals;
	if (values.help || !path || (command !== "schema" && command !== "content")) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}

	const projectPath = resolve(path);
	const project = loadCraftProject(projectPath);
	const schema = mapSchema(project);
	const outDir = resolve(values.out);

	if (command === "schema") {
		write(outDir, schema);
		return 0;
	}

	if (Boolean(values.craft) === Boolean(values.endpoint)) {
		console.error('content needs one of --craft "<console command>" or --endpoint <url>. See --help.');
		return 2;
	}
	const pageSize = Number(values["page-size"]);
	if (!Number.isInteger(pageSize) || pageSize < 1) {
		console.error("--page-size must be a positive whole number");
		return 2;
	}
	// the console runs from the project root: two levels above config/project
	const projectRoot = resolve(resolveConfigDir(projectPath), "..", "..");
	const transport = values.craft
		? consoleExecute(values.craft.trim().split(/\s+/), projectRoot)
		: httpExecute(values.endpoint ?? "", process.env["CRAFT_GQL_TOKEN"]);
	const execute = withRetry(transport, 3, (attempt, error) => {
		process.stderr.write(`\n  request failed (${error.message.split("\n")[0]}); retrying, attempt ${attempt + 1} of 3\n`);
	});

	console.error("Reading Craft's GraphQL schema…");
	try {
		const content = await readContent({
			execute,
			project,
			plan: schema.plan,
			seed: schema.seed,
			pageSize,
			checkpointDir: join(outDir, ".checkpoints"),
			resume: values.resume,
			onProgress: progressPrinter(),
			onMessage: (message) => console.error(message),
			...(values.sections ? { sections: values.sections.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
			...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
		});
		write(outDir, { seed: content.seed, notes: [...schema.notes, ...content.notes] });
		return 0;
	} catch (error) {
		console.error(`\n${error instanceof Error ? error.message : error}`);
		console.error("Sections already read are saved. Run the same command with --resume to continue from there.");
		return 1;
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	},
);
