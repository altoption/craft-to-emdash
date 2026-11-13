import { validateSeed } from "emdash/seed";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCraftProject, mapSchema, toSlug, unpackAssoc } from "../src/index.ts";
import type { SeedField } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
const { seed, notes } = mapSchema(loadCraftProject(fixture));

const collection = (slug: string) => {
	const found = seed.collections.find((c) => c.slug === slug);
	if (!found) throw new Error(`no collection ${slug}`);
	return found;
};
const block = (slug: string) => {
	const found = seed.blockTypes?.find((b) => b.slug === slug)?.versions[0];
	if (!found) throw new Error(`no block type ${slug}`);
	return found;
};
const field = (fields: SeedField[], slug: string) => {
	const found = fields.find((f) => f.slug === slug);
	if (!found) throw new Error(`no field ${slug}`);
	return found;
};
const codes = (code: string) => notes.filter((n) => n.code === code).map((n) => n.where);

describe("helpers", () => {
	it("turns Craft handles into EmDash slugs", () => {
		expect(toSlug("pageBuilder")).toBe("page_builder");
		expect(toSlug("ctaLink2")).toBe("cta_link2");
		expect(toSlug("2col")).toBe("c_2col");
	});

	it("unpacks Craft's ordered maps at every depth", () => {
		expect(unpackAssoc({ options: [{ __assoc__: [["label", "Light"], ["value", "light"]] }] })).toEqual({
			options: [{ label: "Light", value: "light" }],
		});
	});
});

describe("schema pass on the fixture", () => {
	it("produces a seed that EmDash's own validator accepts", () => {
		const result = validateSeed(seed as unknown as Parameters<typeof validateSeed>[0]);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("turns each section into a collection", () => {
		expect(seed.collections.map((c) => c.slug)).toEqual(["blog", "home", "pages"]);
		expect(seed.defaultLocale).toBe("en-US");
		expect(collection("blog")).toMatchObject({
			label: "Blog",
			labelSingular: "Article",
			urlPattern: "/blog/{slug}",
			titleField: "title",
			supports: ["drafts", "revisions"],
		});
	});

	it("maps core field types", () => {
		const fields = collection("blog").fields;
		expect(field(fields, "title")).toMatchObject({ type: "string", required: true });
		expect(field(fields, "summary")).toMatchObject({ type: "text", required: true, validation: { maxLength: 280 } });
		expect(field(fields, "body").type).toBe("portableText");
		expect(field(fields, "hero_image")).toMatchObject({ type: "image", translatable: false });
		expect(field(fields, "rating")).toMatchObject({ type: "integer", validation: { min: 1, max: 5 } });
		expect(field(fields, "featured")).toMatchObject({ type: "boolean", defaultValue: true });
		expect(field(fields, "tone")).toMatchObject({ type: "select", validation: { options: ["light", "dark"] } });
		expect(field(fields, "published_on").type).toBe("datetime");
		expect(field(fields, "related_articles")).toMatchObject({
			type: "reference",
			validation: { targetCollection: "blog", multiple: true },
		});
		expect(field(fields, "gallery")).toMatchObject({
			type: "repeater",
			validation: { maxItems: 8, subFields: [{ slug: "image", type: "image", required: true }] },
		});
	});

	it("turns a Categories field into a taxonomy on the collection, not a field", () => {
		expect(collection("blog").fields.some((f) => f.slug === "topics")).toBe(false);
		expect(seed.taxonomies).toEqual([
			{ name: "regions", label: "Regions", hierarchical: false, collections: [] },
			{ name: "topics", label: "Topics", hierarchical: true, collections: ["blog"] },
		]);
	});

	it("turns a Matrix field into a blocks field and its entry types into block types", () => {
		expect(field(collection("home").fields, "page_builder")).toEqual({
			slug: "page_builder",
			label: "Page Builder",
			type: "blocks",
			validation: { allowedTypes: ["hero", "card_grid", "quote"], maxItems: 100 },
		});
		expect(seed.blockTypes?.map((b) => b.slug)).toEqual(["hero", "card_grid", "quote"]);
		expect(block("hero").fields.map((f) => [f.slug, f.type])).toEqual([
			["heading", "string"],
			["hero_image", "image"],
			["cta_link", "url"],
		]);
		// a blocks field is never required in EmDash, even when the Craft layout requires it
		expect(field(collection("pages").fields, "page_builder").required).toBeUndefined();
	});

	it("turns a nested Matrix of simple rows into a repeater", () => {
		expect(field(block("card_grid").fields, "cards")).toMatchObject({
			type: "repeater",
			validation: {
				minItems: 1,
				maxItems: 6,
				subFields: [
					{ slug: "heading", type: "string", required: true },
					{ slug: "summary", type: "text" },
					{ slug: "hero_image", type: "image" },
					{ slug: "tone", type: "select", options: ["light", "dark"] },
				],
			},
		});
	});

	it("keeps what has no equivalent as JSON and says so", () => {
		expect(field(collection("blog").fields, "attachments").type).toBe("json");
		expect(field(collection("blog").fields, "anything").type).toBe("json");
		expect(field(collection("home").fields, "seo").type).toBe("json");
		// EmDash blocks allow no json, references or nested blocks: the value is kept as JSON text
		for (const slug of ["related_articles", "topics", "slides"]) expect(field(block("quote").fields, slug).type).toBe("text");

		expect(codes("plugin_field")).toEqual(["section home > entry type homePage > field seo"]);
		expect(codes("no_equivalent")).toEqual([
			"section blog > entry type article > field attachments",
			"section blog > entry type article > field anything",
			"block quote > field relatedArticles",
			"block quote > field topics",
			"block quote > field slides",
		]);
	});

	it("merges a section's entry types into one collection", () => {
		const fields = collection("pages").fields;
		expect(field(fields, "entry_type")).toMatchObject({
			type: "select",
			required: true,
			validation: { options: ["page", "landingPage"] },
		});
		// a per-layout handle override that hits a reserved EmDash name
		expect(field(fields, "craft_byline").type).toBe("text");
		// page's summary is text, landingPage's "summary" is a lightswitch under an overridden handle
		expect(field(fields, "summary").type).toBe("text");
		expect(field(fields, "summary_landing_page").type).toBe("boolean");
		expect(codes("field_type_clash")).toEqual(["section pages > field summary"]);
	});

	it("carries the site's name and time zone, and says what happens to each plugin", () => {
		expect(seed.settings).toEqual({ title: "Fixture Site", timezone: "Europe/London" });
		const plugins = notes.filter((n) => n.code === "plugin");
		expect(plugins.map((n) => [n.where, n.level])).toEqual([
			["plugin ckeditor", "info"],
			["plugin seomatic", "info"],
			["plugin site-module", "decide"],
		]);
	});

	it("reports URI formats it cannot express and the locales to configure", () => {
		expect(collection("pages").urlPattern).toBeUndefined();
		expect(codes("uri_format")).toEqual(["section pages"]);
		expect(notes.find((n) => n.code === "locales")?.message).toContain("en-US, fr-FR");
	});
});
