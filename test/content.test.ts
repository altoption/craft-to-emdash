import { validateSeed } from "emdash/seed";
import { buildSchema, graphql } from "graphql";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCraftProject, mapSchema, readContent, toResult } from "../src/index.ts";
import type { Execute, Progress, SeedContentEntry } from "../src/index.ts";

// A stand-in for Craft's GraphQL API, shaped like the schema Craft 5 generates for test/fixtures/basic under a token:
// one `<handle>_Entry` type per entry type, a union per Matrix field, assets and categories behind interfaces.
const ENTRY = "id: ID slug: String status: String siteHandle: String language: String typeHandle: String! title: String uri: String sectionHandle: String";
const schema = buildSchema(`
	scalar DateTime
	scalar Number
	scalar JSON
	interface EntryInterface { ${ENTRY} }
	interface AssetInterface { url: String filename: String! alt: String kind: String! }
	type uploads_Asset implements AssetInterface { url: String filename: String! alt: String kind: String! }
	interface CategoryInterface { slug: String title: String parent: CategoryInterface }
	type topics_Category implements CategoryInterface { slug: String title: String parent: CategoryInterface }
	type LinkData { url: String label: String type: String }
	type SeoData { metaTitle: String metaDescription: String image(size: Int!): String extra: JSON form: FormElement }
	type FormElement { id: ID uid: String siteHandle: String handle: String }
	type tabs_Entry implements EntryInterface { ${ENTRY} heading: String panels: [panels_MatrixField]! }
	type panel_Entry implements EntryInterface  { ${ENTRY} heading: String body: String slides: [slides_MatrixField]! }
	type article_Entry implements EntryInterface { ${ENTRY}
		summary: String body: String heroImage: [AssetInterface]! gallery: [AssetInterface]! rating: Number featured: Boolean
		tone: String publishedOn: DateTime relatedArticles: [EntryInterface]! topics: [CategoryInterface]!
		attachments: [AssetInterface]! anything: [EntryInterface]! }
	type homePage_Entry implements EntryInterface { ${ENTRY} pageBuilder: [pageBuilder_MatrixField]! seo: SeoData }
	type page_Entry implements EntryInterface { ${ENTRY} pageBuilder: [pageBuilder_MatrixField]! byline: String summary: String }
	type landingPage_Entry implements EntryInterface { ${ENTRY} summary: Boolean }
	type hero_Entry implements EntryInterface { ${ENTRY} heading: String heroImage: [AssetInterface]! ctaLink: LinkData }
	type cardGrid_Entry implements EntryInterface { ${ENTRY} heading: String cards: [cards_MatrixField]! }
	type card_Entry implements EntryInterface { ${ENTRY} heading: String summary: String heroImage: [AssetInterface]! tone: String }
	type quote_Entry implements EntryInterface { ${ENTRY}
		summary: String relatedArticles: [EntryInterface]! topics: [CategoryInterface]! slides: [slides_MatrixField]! }
	type slide_Entry implements EntryInterface { ${ENTRY} heading: String body: String }
	interface GlobalSetInterface { handle: String! language: String }
	type footer_GlobalSet implements GlobalSetInterface { handle: String! language: String summary: String logo: [AssetInterface]! }
	type RetourType { redirectSrcUrl: String redirectDestUrl: String redirectHttpCode: Int redirectMatchType: String enabled: Boolean }
	union pageBuilder_MatrixField = hero_Entry | cardGrid_Entry | quote_Entry | tabs_Entry | panel_Entry
	union cards_MatrixField = card_Entry
	union slides_MatrixField = slide_Entry
	union panels_MatrixField = panel_Entry
	type Query {
		globalSets(site: [String]): [GlobalSetInterface]
		retourRedirects: [RetourType]
		entries(section: [String], site: [String], status: [String], limit: Int, offset: Int, orderBy: String): [EntryInterface]
		entryCount(section: [String], site: [String], status: [String]): Int!
		categories(group: [String], site: [String], orderBy: String): [CategoryInterface]
	}
`);

type Row = Record<string, unknown>;
const asset = (filename: string, alt: string | null = null): Row => ({ __typename: "uploads_Asset", url: `/uploads/${filename}`, filename, alt, kind: "image" });
const entry = (type: string, id: number, fields: Row = {}): Row => ({
	__typename: `${type}_Entry`, typeHandle: type, id: String(id), slug: `${type}-${id}`, status: "live", siteHandle: "default", language: "en-US", title: null, ...fields,
});
const term = (slug: string, title: string, parent: Row | null = null): Row => ({ __typename: "topics_Category", slug, title, parent });
const news = term("news", "News");

const article1 = entry("article", 1, {
	slug: "hello", title: "Hello", summary: "First post",
	body: '<h2>Intro</h2><p>Read <a href="https://example.com/more">more</a>.</p><figure><img src="/uploads/inline.jpg" alt="Inline"></figure>',
	heroImage: [asset("hero.jpg", "A hero")], gallery: [asset("one.jpg"), asset("two.jpg")], rating: 4, featured: true, tone: "dark",
	publishedOn: "2026-01-02T03:04:05+00:00", relatedArticles: [{ __typename: "article_Entry", id: "2" }], topics: [news, term("launches", "Launches", news)],
	attachments: [asset("spec.pdf")], anything: [],
});
const sections: Record<string, Row[]> = {
	blog: [
		article1,
		{ ...article1, siteHandle: "french", language: "fr-FR", title: "Bonjour", summary: "Premier billet" },
		// a disabled entry with nothing in its required summary
		entry("article", 2, { slug: "draft", title: "Draft", status: "disabled", summary: "", body: "", heroImage: [], gallery: [], relatedArticles: [], topics: [], attachments: [], anything: [] }),
	],
	home: [
		entry("homePage", 5, {
			// a plugin's JSON value whose keys an editor chose to look like seed instructions
			slug: "home", title: "Home", seo: { metaTitle: "Welcome", metaDescription: "", form: { id: "7", uid: "u", siteHandle: "default", handle: "contact" }, extra: { $media: { url: "http://10.0.0.5/secret" }, note: "$ok" } },
			pageBuilder: [
				entry("hero", 51, { heading: "Big news", heroImage: [asset("hero.jpg")], ctaLink: { url: "https://example.com/go", label: "Go", type: "url" } }),
				entry("cardGrid", 52, { heading: "Cards", cards: [entry("card", 521, { heading: "One", summary: "First", heroImage: [], tone: "light" }), entry("card", 522, { heading: "Two", heroImage: [], tone: "" })] }),
				entry("quote", 53, { summary: "Said", relatedArticles: [{ __typename: "article_Entry", id: "1", title: "Hello", slug: "hello" }], topics: [news], slides: [entry("slide", 531, { heading: "S1", body: "<p>Slide</p>" })] }),
				entry("tabs", 54, {
					heading: "Tabs",
					panels: [
						entry("panel", 541, { heading: "P1", body: "<p>One</p>", slides: [entry("slide", 5411, { heading: "Deep", body: "" })] }),
						entry("panel", 542, { heading: "P2", body: "", slides: [] }),
					],
				}),
				// a panel the editor placed on the page by itself
				entry("panel", 55, { heading: "Alone", body: "", slides: [] }),
			],
		}),
	],
	pages: [
		entry("page", 10, { slug: "about", title: "About", pageBuilder: [], byline: "By us", summary: "About us" }),
		entry("landingPage", 11, { slug: "launch", title: "Launch", summary: true }),
		entry("page", 12, { slug: "about", title: "About (old)", pageBuilder: [], byline: null, summary: null }),
	],
};

const footer = (language: string, summary: string): Row => ({ __typename: "footer_GlobalSet", handle: "footer", language, summary, logo: [asset("logo.svg")] });
const redirect = (redirectSrcUrl: string, redirectDestUrl: string, redirectHttpCode = 301, redirectMatchType = "exactmatch", enabled = true): Row => ({
	redirectSrcUrl, redirectDestUrl, redirectHttpCode, redirectMatchType, enabled,
});

function fakeCraft(overrides: { failEntries?: boolean; schema?: typeof schema } = {}): { execute: Execute; queries: string[] } {
	const queries: string[] = [];
	const rootValue = {
		// the secondary site comes first, as Craft may return it
		globalSets: () => [footer("fr-FR", "Pied de page"), footer("en-US", "Small print")],
		retourRedirects: () => [
			redirect("/old", "/new"),
			redirect("legacy/page", "/blog/hello", 302, "exactmatch", false),
			redirect("/old", "/elsewhere"),
			redirect("/shop/(.*)", "/store/$1", 301, "regexmatch"),
			redirect("/partner", "https://partner.example/"),
			redirect("/gone", "/", 410),
		],
		entries: ({ section, limit, offset }: { section: string[]; limit: number; offset: number }) => {
			if (overrides.failEntries) throw new Error("Craft is down");
			return (sections[section[0] ?? ""] ?? []).slice(offset, offset + limit);
		},
		entryCount: ({ section }: { section: string[] }) => (sections[section[0] ?? ""] ?? []).length,
		categories: ({ group }: { group: string[] }) => (group[0] === "topics" ? [news, term("launches", "Launches", news)] : []),
	};
	const execute: Execute = async (source, variableValues) => {
		queries.push(source);
		return toResult(await graphql({ schema: overrides.schema ?? schema, source, rootValue, variableValues: variableValues ?? {} }) as Parameters<typeof toResult>[0]);
	};
	return { execute, queries };
}

const project = loadCraftProject(fileURLToPath(new URL("./fixtures/basic", import.meta.url)));
const mapped = mapSchema(project);
const run = (execute: Execute, extra: Partial<Parameters<typeof readContent>[0]> = {}) =>
	readContent({ execute, project, plan: mapped.plan, seed: mapped.seed, baseUrl: "https://craft.example", pageSize: 2, ...extra });

const { seed, notes, assetHosts } = await run(fakeCraft().execute);
const entries = (collection: string): SeedContentEntry[] => seed.content?.[collection] ?? [];
const byId = (collection: string, id: string): SeedContentEntry => {
	const found = entries(collection).find((e) => e.id === id);
	if (!found) throw new Error(`no entry ${id} in ${collection}`);
	return found;
};
const codes = (code: string) => notes.filter((n) => n.code === code).map((n) => n.where);

describe("content pass on the fixture", () => {
	it("produces a seed that EmDash's own validator accepts", () => {
		const result = validateSeed(seed as unknown as Parameters<typeof validateSeed>[0]);
		expect(result.errors).toEqual([]);
	});

	it("reads every page of a section and turns sites into translations", () => {
		expect(entries("blog").map((e) => [e.id, e.slug, e.status, e.locale, e.translationOf])).toEqual([
			["craft-1", "hello", "published", "en-US", undefined],
			["craft-1-fr-FR", "hello", "published", "fr-FR", "craft-1"],
			["craft-2", "draft", "draft", "en-US", undefined],
		]);
		expect(byId("blog", "craft-1-fr-FR").data["title"]).toBe("Bonjour");
	});

	it("converts each kind of field", () => {
		const { data, taxonomies } = byId("blog", "craft-1");
		expect(data).toMatchObject({
			title: "Hello",
			summary: "First post",
			rating: 4,
			featured: true,
			tone: "dark",
			published_on: "2026-01-02T03:04:05+00:00",
			related_articles: "$ref:craft-2",
			hero_image: { $media: { url: "https://craft.example/uploads/hero.jpg", filename: "hero.jpg", alt: "A hero" } },
			gallery: [
				{ image: { $media: { url: "https://craft.example/uploads/one.jpg", filename: "one.jpg" } } },
				{ image: { $media: { url: "https://craft.example/uploads/two.jpg", filename: "two.jpg" } } },
			],
			// no EmDash field holds several files: kept as JSON
			attachments: [{ url: "/uploads/spec.pdf", filename: "spec.pdf", kind: "image" }],
		});
		expect(data).not.toHaveProperty("anything");
		expect(taxonomies).toEqual({ topics: ["news", "launches"] });
	});

	it("converts rich text to Portable Text with stable keys and media references", () => {
		expect(byId("blog", "craft-1").data["body"]).toEqual([
			{ _type: "block", _key: "k1", style: "h2", children: [{ _type: "span", _key: "k2", text: "Intro" }] },
			{
				_type: "block",
				_key: "k3",
				style: "normal",
				children: [
					{ _type: "span", _key: "k4", text: "Read " },
					{ _type: "span", _key: "k5", text: "more", marks: ["k7"] },
					{ _type: "span", _key: "k6", text: "." },
				],
				markDefs: [{ _type: "link", _key: "k7", href: "https://example.com/more" }],
			},
			{ _type: "image", _key: "k8", asset: { $media: { url: "https://craft.example/uploads/inline.jpg", alt: "Inline" } }, alt: "Inline" },
		]);
	});

	it("turns Matrix entries into blocks, repeater rows, flattened blocks, and JSON where nothing fits", () => {
		const blocks = byId("home", "craft-5").data["page_builder"];
		expect(blocks).toEqual([
			{
				_type: "hero",
				heading: "Big news",
				hero_image: { $media: { url: "https://craft.example/uploads/hero.jpg", filename: "hero.jpg" } },
				cta_link: "https://example.com/go",
			},
			{ _type: "card_grid", heading: "Cards", cards: [{ heading: "One", summary: "First", tone: "light" }, { heading: "Two" }] },
			{
				_type: "quote",
				summary: "Said",
				related_articles: JSON.stringify([{ id: "1", title: "Hello", slug: "hello" }]),
				topics: JSON.stringify([{ slug: "news", title: "News" }]),
			},
			// the quote's nested slide, flattened to a block right after it, with real rich text
			{ _type: "slide", heading: "S1", body: [{ _type: "block", _key: "k1", style: "normal", children: [{ _type: "span", _key: "k2", text: "Slide" }] }] },
			// three levels: each panel follows its tabs block, and a panel's slide follows that panel
			{ _type: "tabs", heading: "Tabs" },
			{ _type: "panel", heading: "P1", body: [{ _type: "block", _key: "k1", style: "normal", children: [{ _type: "span", _key: "k2", text: "One" }] }], belongs_to: "tabs.panels" },
			{ _type: "slide", heading: "Deep" },
			{ _type: "panel", heading: "P2", belongs_to: "tabs.panels" },
			// a panel standing alone has no belongs_to, which is how a template tells the two apart
			{ _type: "panel", heading: "Alone" },
		]);
		// a plugin field is read through whatever scalars its GraphQL type offers, skipping fields that need arguments
		// and a key that would be an instruction to EmDash's seed is kept as plain data
		expect(byId("home", "craft-5").data["seo"]).toEqual({
			metaTitle: "Welcome",
			// a plugin's element type with no title or uri: it is identified by what it does have
			form: { id: "7" },
			extra: { "_$media": { url: "http://10.0.0.5/secret" }, note: "$ok" },
		});
	});

	it("keeps entry types apart when they give one handle to different field types", () => {
		expect(byId("pages", "craft-10").data).toEqual({ entry_type: "page", title: "About", craft_byline: "By us", summary: "About us" });
		expect(byId("pages", "craft-11").data).toEqual({ entry_type: "landingPage", title: "Launch", summary_landing_page: true });
	});

	it("renames a duplicate slug rather than losing the entry", () => {
		expect(entries("pages").map((e) => e.slug)).toEqual(["about", "launch", "about-12"]);
		expect(codes("duplicate_slug")).toEqual(["section pages > slug about"]);
	});

	it("makes a required field optional when real content leaves it empty", () => {
		const summary = seed.collections.find((c) => c.slug === "blog")?.fields.find((f) => f.slug === "summary");
		expect(summary?.required).toBeUndefined();
		expect(codes("required_relaxed")).toContain("collection blog > field summary");
		// the schema pass's seed is left as it was
		expect(mapped.seed.collections.find((c) => c.slug === "blog")?.fields.find((f) => f.slug === "summary")?.required).toBe(true);
	});

	it("reports the hosts asset fields use, and not those of addresses found in rich text or raw JSON", () => {
		expect(assetHosts).toEqual(["craft.example"]);
	});

	it("reads category groups as taxonomy terms", () => {
		expect(seed.taxonomies?.find((t) => t.name === "topics")?.terms).toEqual([
			{ slug: "news", label: "News" },
			{ slug: "launches", label: "Launches", parent: "news" },
		]);
		expect(seed.taxonomies?.find((t) => t.name === "regions")?.terms).toBeUndefined();
	});
});

describe("global sets and redirects", () => {
	it("reads a global set as the one entry of its collection, with its translations", () => {
		expect(entries("global_footer")).toEqual([
			{
				id: "global-footer",
				status: "published",
				locale: "en-US",
				data: { summary: "Small print", logo: { $media: { url: "https://craft.example/uploads/logo.svg", filename: "logo.svg" } } },
			},
			{
				id: "global-footer-fr-FR",
				status: "published",
				locale: "fr-FR",
				translationOf: "global-footer",
				data: { summary: "Pied de page", logo: { $media: { url: "https://craft.example/uploads/logo.svg", filename: "logo.svg" } } },
			},
		]);
	});

	it("converts exact, local redirects and lists the ones EmDash cannot hold", () => {
		expect(seed.redirects).toEqual([
			{ source: "/old", destination: "/new", type: 301, enabled: true, groupName: "Craft (Retour)" },
			{ source: "/legacy/page", destination: "/blog/hello", type: 302, enabled: false, groupName: "Craft (Retour)" },
		]);
		const skipped = notes.filter((n) => n.code === "redirect_skipped").map((n) => n.message);
		expect(skipped).toHaveLength(4);
		expect(skipped.join("\n")).toMatch(/another redirect already has this source: \/old\./);
		expect(skipped.join("\n")).toMatch(/matches by pattern.*: \/shop\/\(\.\*\)\./);
		expect(skipped.join("\n")).toMatch(/points to another site.*: \/partner\./);
		expect(skipped.join("\n")).toMatch(/status code is 410.*: \/gone\./);
	});

	it("reads an entry type that nests itself a fixed number of levels deep, and says so", async () => {
		// a `panel` whose slides field also accepts panels: the query would otherwise never end
		const looped = structuredClone(mapped.plan);
		const panel = Object.values(looped.blocks).find((b) => b.handle === "panel");
		const slides = panel?.bindings.find((b) => b.handle === "slides");
		if (!panel || !slides) throw new Error("the fixture no longer has panel.slides");
		slides.entryTypeUids = [...(slides.entryTypeUids ?? []), panel.uid];
		const { printSchema } = await import("graphql");
		const loopSchema = buildSchema(printSchema(schema).replace("union slides_MatrixField = slide_Entry", "union slides_MatrixField = slide_Entry | panel_Entry"));
		const fake = fakeCraft({ schema: loopSchema });
		const result = await readContent({ execute: fake.execute, project, plan: looped, seed: mapped.seed, sections: ["home"] });
		const query = fake.queries.find((q) => q.includes("query Entries")) ?? "";
		// three levels of panel under tabs, and three for a panel placed on the page by itself; none deeper
		expect(query.match(/\.\.\. on panel_Entry/g)).toHaveLength(6);
		expect(result.notes.filter((n) => n.code === "nesting_too_deep").map((n) => n.where)).toEqual(["panel_Entry > field slides"]);
	});

	it("says so when the token's schema cannot see a section, instead of writing it empty", async () => {
		// the same API as seen by a token with no access to landing pages or the footer
		const { printSchema } = await import("graphql");
		const limited = buildSchema(
			printSchema(schema)
				.replace(/type landingPage_Entry[^}]*}/, "")
				.replace(/type footer_GlobalSet[^}]*}/, ""),
		);
		const partial = await run(fakeCraft({ schema: limited }).execute);
		expect(partial.notes.filter((n) => n.code === "not_readable").map((n) => n.where)).toEqual([
			"section pages > entry type landingPage",
			"global set footer",
		]);
		expect(partial.seed.content?.["global_footer"]).toBeUndefined();
	});
});

describe("running the content pass", () => {
	it("reads only the sections asked for, and rejects one that does not exist", async () => {
		const only = await run(fakeCraft().execute, { sections: ["home"] });
		expect(Object.keys(only.seed.content ?? {})).toEqual(["home"]);
		expect(only.seed.redirects).toBeUndefined();
		await expect(run(fakeCraft().execute, { sections: ["nope"] })).rejects.toThrow('No section "nope"');
	});

	it("reports progress for each section", async () => {
		const seen: Progress[] = [];
		await run(fakeCraft().execute, { sections: ["blog"], onProgress: (p) => seen.push(p) });
		expect(seen.map((p) => [p.state, p.fetched, p.count])).toEqual([
			["reading", 0, 3],
			["reading", 2, 3],
			["reading", 3, 3],
			["done", 3, 3],
		]);
	});

	it("resumes from the sections an interrupted run finished", async () => {
		const checkpointDir = mkdtempSync(join(tmpdir(), "c2e-"));
		const first = await run(fakeCraft().execute, { checkpointDir });
		// Craft now fails every entries query: a resumed run must not need one
		const down = fakeCraft({ failEntries: true });
		const seen: Progress[] = [];
		const second = await run(down.execute, { checkpointDir, resume: true, onProgress: (p) => seen.push(p) });
		expect(second.seed).toEqual(first.seed);
		expect(second.notes).toEqual(first.notes);
		expect(second.assetHosts).toEqual(first.assetHosts);
		// a section resumed alone still knows its asset hosts, though an earlier section met the same host first
		const alone = await run(down.execute, { checkpointDir, resume: true, sections: ["home"] });
		expect(alone.assetHosts).toEqual(["craft.example"]);
		expect(seen.map((p) => p.state)).toEqual(["resumed", "resumed", "resumed"]);
		// without --resume the checkpoints are ignored
		await expect(run(down.execute, { checkpointDir })).rejects.toThrow();
	});

	it("turns a field-level error from Craft into a note and keeps the rest", async () => {
		const { execute } = fakeCraft();
		const failing: Execute = async (query, variables) => {
			const result = await execute(query, variables);
			return query.includes("query Entries") ? { ...result, errors: [{ message: "String cannot represent value", path: ["entries", 0, "article__rating"] }] } : result;
		};
		const partial = await run(failing, { sections: ["blog"] });
		expect(partial.seed.content?.["blog"]).toHaveLength(3);
		expect(partial.notes.filter((n) => n.code === "graphql_error").map((n) => n.where)).toEqual(["section blog > article__rating"]);
	});
});
