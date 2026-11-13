import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertReadOnly, consoleExecute, GraphqlRequestError } from "../src/index.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-console.mjs", import.meta.url));
const consoleIn = (mode: string, timeoutMs?: number) =>
	consoleExecute([process.execPath, fake, mode], process.cwd(), timeoutMs ? { timeoutMs } : {});

describe("the read-only guard", () => {
	it("accepts a single query, named or not", () => {
		expect(() => assertReadOnly("{ entryCount }")).not.toThrow();
		expect(() => assertReadOnly("query Entries($s: [String]) { entries(section: $s) { id ...F } } fragment F on EntryInterface { slug }")).not.toThrow();
	});

	it.each([
		["a plain mutation", "mutation { save_blog_article_Entry(title: \"x\") { id } }"],
		["a mutation after a comment", "# harmless-looking comment\nmutation { deleteEntry(id: 1) }"],
		["a mutation after commas", ",,, mutation { deleteEntry(id: 1) }"],
		["a mutation after a fragment", "fragment F on EntryInterface { id } mutation { deleteEntry(id: 1) }"],
		["a query with a mutation beside it", "query A { entryCount } mutation B { deleteEntry(id: 1) }"],
		["two queries, where Craft would have to pick one", "query A { entryCount } query B { entryCount }"],
		["a subscription", "subscription { entryChanged { id } }"],
		["text that is not GraphQL", "delete everything"],
	])("refuses %s", (_name, document) => {
		expect(() => assertReadOnly(document)).toThrow(GraphqlRequestError);
	});

	it("is applied by the console transport before anything runs", async () => {
		await expect(consoleIn("ok")("# note\nmutation { deleteEntry(id: 1) }")).rejects.toThrow("only reads from Craft");
	});
});

describe("the console transport", () => {
	it("returns the result of a query passed on the command line", async () => {
		const query = "{ entryCount }";
		await expect(consoleIn("ok")(query)).resolves.toEqual({ data: { echo: query.length }, errors: [] });
	});

	it("sends a long query through standard input", async () => {
		const query = `{ ${Array.from({ length: 3000 }, (_, i) => `a${i}: entryCount`).join(" ")} }`;
		await expect(consoleIn("ok")(query)).resolves.toEqual({ data: { echo: query.length }, errors: [] });
	});

	it("treats a command that printed a result and then failed as a failed request", async () => {
		await expect(consoleIn("crash")("{ entryCount }")).rejects.toThrow(/failed/);
	});

	it("rejects when the command stops without answering a query sent through standard input", async () => {
		const query = `{ ${Array.from({ length: 60_000 }, (_, i) => `a${i}: entryCount`).join(" ")} }`;
		await expect(consoleIn("deaf")(query)).rejects.toThrow(/stopped reading the query|gave no result/);
	});

	it("gives up on a command that does not finish in time", async () => {
		await expect(consoleIn("slow", 300)("{ entryCount }")).rejects.toThrow(/did not finish within/);
	});

	it("says so when the console command does not exist", async () => {
		const execute = consoleExecute(["craft-to-emdash-no-such-command"], process.cwd());
		await expect(execute("{ entryCount }")).rejects.toThrow(/was not found/);
	});
});
