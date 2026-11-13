// The content pass: reads entries and categories over Craft's GraphQL API, following the plan the schema pass made,
// and writes them as seed content.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CraftField, CraftProject } from "../craft/load.ts";
import type { Binding, EntryPlan, Note, Plan } from "../map/schema.ts";
import type { RepeaterSubField, SeedContentEntry, SeedField, SeedFile, SeedRedirect, SeedTaxonomyTerm } from "../seed/types.ts";
import { webHost } from "./assets.ts";
import { introspect } from "./graphql.ts";
import type { Execute, FieldType, TypeIndex } from "./graphql.ts";
import { htmlToBlocks } from "./richtext.ts";

export interface ContentOptions {
	execute: Execute;
	project: CraftProject;
	plan: Plan;
	/** The seed from the schema pass; content and taxonomy terms are added to a copy of it. */
	seed: SeedFile;
	/** Section handles to read; all sections when omitted. */
	sections?: string[];
	/** Resolves root-relative asset URLs, e.g. the site's base URL. */
	baseUrl?: string;
	pageSize?: number;
	/** Where each finished section is saved, so an interrupted run can pick up from there. */
	checkpointDir?: string;
	/** Reuse sections saved in checkpointDir by an earlier run of the same queries. */
	resume?: boolean;
	onProgress?: (progress: Progress) => void;
	/** One-line updates for the steps that are not sections: global sets, redirects. */
	onMessage?: (message: string) => void;
}

export interface Progress {
	section: string;
	/** 1-based position of the section among those being read. */
	index: number;
	total: number;
	fetched: number;
	/** Entries Craft says the section has, across sites and statuses. */
	count: number;
	state: "reading" | "done" | "resumed";
}

export interface ContentResult {
	seed: SeedFile;
	notes: Note[];
	/** Hosts of the URLs Craft's asset fields returned: the ones it is safe to download assets from. */
	assetHosts: string[];
}

type Json = Record<string, unknown>;

const ASSET = "url filename alt kind";
const STATUSES = '["live", "pending", "expired", "disabled"]';
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const isLeaf = (t: FieldType): boolean => t.kind === "SCALAR" || t.kind === "ENUM";

/**
 * Two entry types may give one handle to fields of different types, and GraphQL refuses a query whose fragments
 * select the same response name with different shapes. Aliasing each field by its entry type keeps them apart.
 */
const aliased = (entryType: string, handle: string): string => `${entryType.replace(/_(Entry|GlobalSet)$/, "")}__${handle}: ${handle}`;
const REDIRECT_CODES = new Set([301, 302, 307, 308]);
/** Changes whenever what a checkpoint holds changes, so an older run's files are read again rather than misread. */
const CHECKPOINT_VERSION = "2";
const ALIAS = /^[A-Za-z0-9]+__/;

class ContentReader {
	readonly notes: Note[] = [];
	private readonly noted = new Set<string>();
	/** "<scope>.<field slug>" -> how many entries, blocks or rows lack a value the seed says is required. */
	private readonly missing = new Map<string, number>();
	private readonly required = new Map<string, Set<string>>();
	private readonly assetHosts = new Set<string>();
	/** The hosts used by the section being read, for its checkpoint: a later run may resume that section alone. */
	private sectionHosts = new Set<string>();
	private readonly opts: ContentOptions;
	private readonly types: TypeIndex;

	constructor(opts: ContentOptions, types: TypeIndex) {
		this.opts = opts;
		this.types = types;
		const requiredOf = (fields: Array<{ slug: string; required?: boolean }>): Set<string> =>
			new Set(fields.filter((f) => f.required).map((f) => f.slug));
		for (const c of opts.seed.collections) this.required.set(`collection:${c.slug}`, requiredOf(c.fields));
		for (const b of opts.seed.blockTypes ?? []) {
			const fields = b.versions[0]?.fields ?? [];
			this.required.set(`block:${b.slug}`, requiredOf(fields));
			for (const f of fields) {
				const subFields = f.type === "repeater" ? f.validation?.["subFields"] : undefined;
				if (Array.isArray(subFields)) this.required.set(`row:${b.slug}.${f.slug}`, requiredOf(subFields as RepeaterSubField[]));
			}
		}
	}

	private note(level: Note["level"], code: string, where: string, message: string): void {
		const key = `${code}|${where}`;
		if (this.noted.has(key)) return;
		this.noted.add(key);
		this.notes.push({ level, code, where, message });
	}

	// ---- building queries -------------------------------------------------------------------------------------

	private fieldType(parentType: string, handle: string): FieldType | undefined {
		const type = this.types.fields.get(parentType)?.get(handle);
		if (!type) {
			this.note("decide", "not_in_graphql", `${parentType} > field ${handle}`, "Craft's GraphQL schema does not expose this field, so its values are not read. Check the token's schema, or that the field type supports GraphQL.");
		}
		return type;
	}

	/** Every scalar a type offers, and one more level of its object fields: for values we keep as raw JSON. */
	private generic(typeName: string, depth: number): string {
		const fields = this.types.fields.get(typeName);
		if (!fields) return "__typename";
		// an element (entry, asset, category, user): identify it rather than walking all of it
		if (fields.has("uid") && fields.has("siteHandle")) return "id title uri";
		const parts: string[] = [];
		for (const [name, type] of fields) {
			if (type.requiresArgs) continue;
			if (isLeaf(type)) parts.push(name);
			else if (depth > 0) parts.push(`${name} { ${this.generic(type.name, depth - 1)} }`);
		}
		return parts.length ? parts.join(" ") : "__typename";
	}

	/**
	 * Whether a Matrix field can hold this entry type, going by Craft's GraphQL schema rather than its project config.
	 * The two disagree when fields share a handle, and spreading a type the field cannot be makes Craft reject the query.
	 */
	private offers(matrixType: FieldType, entryType: string, where: string): boolean {
		const possible = this.types.possible.get(matrixType.name);
		if (!possible || possible.has(entryType)) return true;
		this.note("decide", "not_in_graphql", where, `Craft's GraphQL schema does not offer ${entryType} on this field, so nested entries of that type are not read.`);
		return false;
	}

	private entryFragment(plan: EntryPlan): string {
		const type = plan.gqlType;
		const fields = plan.bindings.map((b) => this.selection(type, b)).filter((s): s is string => s !== null);
		// __typename keeps the fragment valid when the entry type has no fields of its own
		return `... on ${type} { __typename ${fields.join(" ")} }`;
	}

	private rawSelection(parentType: string, fieldHandle: string, field: CraftField | undefined, stack: string[]): string | null {
		const type = this.fieldType(parentType, fieldHandle);
		if (!type) return null;
		const handle = aliased(parentType, fieldHandle);
		if (isLeaf(type)) return handle;
		switch (field?.type) {
			case "craft\\fields\\Assets":
				return `${handle} { ${ASSET} }`;
			case "craft\\fields\\Entries":
				return `${handle} { id title slug uri sectionHandle }`;
			case "craft\\fields\\Categories":
				return `${handle} { slug title }`;
			case "craft\\fields\\Matrix": {
				const fragments: string[] = [];
				for (const entry of list(field.settings["entryTypes"])) {
					const uid = typeof entry === "string" ? entry : isObject(entry) ? String(entry["uid"]) : "";
					const entryType = this.opts.project.entryTypes.get(uid);
					if (!entryType || stack.includes(uid)) continue;
					const nested = `${entryType.handle}_Entry`;
					if (!this.offers(type, nested, `${parentType} > field ${fieldHandle}`)) continue;
					const inner = entryType.elements
						.filter((el) => el.fieldUid)
						.map((el) => {
							const child = this.opts.project.fields.get(el.fieldUid ?? "");
							return child ? this.rawSelection(nested, el.handle ?? child.handle, child, [...stack, uid]) : null;
						})
						.filter((s): s is string => s !== null);
					fragments.push(`... on ${nested} { __typename ${inner.join(" ")} }`);
				}
				return `${handle} { typeHandle title ${fragments.join(" ")} }`;
			}
			default:
				return `${handle} { ${this.generic(type.name, 1)} }`;
		}
	}

	private selection(parentType: string, b: Binding): string | null {
		if (b.kind === "raw") return this.rawSelection(parentType, b.handle, this.opts.project.fields.get(b.fieldUid), []);
		const type = this.fieldType(parentType, b.handle);
		if (!type) return null;
		const handle = aliased(parentType, b.handle);
		switch (b.kind) {
			case "scalar":
				return isLeaf(type) ? handle : `${handle} { ${this.generic(type.name, 1)} }`;
			case "link":
				return isLeaf(type) ? handle : `${handle} { url }`;
			case "richtext":
				return isLeaf(type) ? handle : `${handle} { html }`;
			case "image":
			case "file":
			case "images":
				return `${handle} { ${ASSET} }`;
			case "reference":
				return `${handle} { id }`;
			case "taxonomy":
				return `${handle} { slug }`;
			case "blocks":
			case "repeater": {
				const plans = b.kind === "blocks" ? this.opts.plan.blocks : this.opts.plan.rows;
				const fragments = (b.entryTypeUids ?? [])
					.map((uid) => plans[uid])
					.filter((p): p is EntryPlan & { slug: string } => p !== undefined)
					.filter((p) => this.offers(type, p.gqlType, `${parentType} > field ${b.handle}`))
					.map((p) => this.entryFragment(p));
				return `${handle} { typeHandle title ${fragments.join(" ")} }`;
			}
		}
	}

	entriesQuery(entryTypes: EntryPlan[]): string {
		const fragments = entryTypes.map((p) => this.entryFragment(p)).join("\n    ");
		return `query Entries($section: [String], $limit: Int, $offset: Int) {
  entries(section: $section, site: ["*"], status: ${STATUSES}, limit: $limit, offset: $offset, orderBy: "id asc") {
    id slug status siteHandle language typeHandle title
    ${fragments}
  }
}`;
	}

	// ---- reading values ---------------------------------------------------------------------------------------

	private url(url: string): string {
		if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
		if (!this.opts.baseUrl) {
			this.note("decide", "relative_url", "assets", `Asset URLs such as ${url} are relative. Pass --base-url so EmDash can download them.`);
			return url;
		}
		return new URL(url, this.opts.baseUrl).toString();
	}

	private media(asset: unknown): Json | null {
		if (!isObject(asset) || typeof asset["url"] !== "string" || asset["url"] === "") return null;
		const url = this.url(asset["url"]);
		const host = webHost(url);
		if (host) {
			this.assetHosts.add(host);
			this.sectionHosts.add(host);
		}
		return {
			$media: {
				url,
				...(typeof asset["filename"] === "string" ? { filename: asset["filename"] } : {}),
				...(typeof asset["alt"] === "string" && asset["alt"] ? { alt: asset["alt"] } : {}),
			},
		};
	}

	/** Raw JSON for a value with no EmDash field type: GraphQL bookkeeping removed, emptiness collapsed to null. */
	private raw(value: unknown): unknown {
		if (Array.isArray(value)) {
			const items = value.map((v) => this.raw(v)).filter((v) => v !== null);
			return items.length ? items : null;
		}
		if (isObject(value)) {
			const out: Json = {};
			for (const [k, v] of Object.entries(value)) {
				if (k === "__typename") continue;
				const cleaned = this.raw(v);
				// `$media` and `$ref` mean something to EmDash's seed. A value kept as raw JSON may carry keys an editor
				// chose (a plugin's JSON field), and those must stay data.
				if (cleaned !== null) out[k.replace(ALIAS, "").replace(/^\$/, "_$")] = cleaned;
			}
			return Object.keys(out).length ? out : null;
		}
		return value === "" || value === undefined ? null : value;
	}

	private value(b: Binding, v: unknown, scope: string): unknown {
		switch (b.kind) {
			case "scalar":
				// a custom scalar can answer with a whole JSON value
				return typeof v === "object" && v !== null ? this.raw(v) : v === "" || v === undefined ? null : v;
			case "link": {
				const url = isObject(v) ? v["url"] : v;
				return typeof url === "string" && url !== "" ? url : null;
			}
			case "richtext": {
				const html = isObject(v) ? v["html"] : v;
				return typeof html === "string" ? htmlToBlocks(html, (u) => this.url(u)) : null;
			}
			case "image":
			case "file":
				return this.media(list(v)[0]);
			case "images": {
				const rows = list(v)
					.map((a) => this.media(a))
					.filter((m) => m !== null)
					.map((image) => ({ image }));
				return rows.length ? rows : null;
			}
			case "reference": {
				const refs = list(v)
					.map((e) => (isObject(e) && e["id"] != null ? `$ref:craft-${String(e["id"])}` : null))
					.filter((r) => r !== null);
				return refs.length === 0 ? null : refs.length === 1 ? refs[0] : refs;
			}
			case "blocks": {
				const blocks = list(v).flatMap((item) => {
					if (!isObject(item)) return [];
					const plan = (b.entryTypeUids ?? []).map((uid) => this.opts.plan.blocks[uid]).find((p) => p?.handle === item["typeHandle"]);
					return plan ? [{ _type: plan.slug, ...this.entryData(plan, item, `block:${plan.slug}`).data }] : [];
				});
				return blocks.length ? blocks : null;
			}
			case "repeater": {
				const plan = this.opts.plan.rows[b.entryTypeUids?.[0] ?? ""];
				// a repeater only exists inside a block, so its rows are scoped by that block and field
				const rowScope = `row:${scope.replace(/^block:/, "")}.${b.slug}`;
				const rows = plan ? list(v).filter(isObject).map((item) => this.entryData(plan, item, rowScope).data) : [];
				return rows.length ? rows : null;
			}
			case "raw": {
				const cleaned = this.raw(v);
				return cleaned !== null && b.rawAsText ? JSON.stringify(cleaned) : cleaned;
			}
			case "taxonomy":
				return null;
		}
	}

	private entryData(plan: EntryPlan, item: Json, scope: string): { data: Json; taxonomies: Record<string, string[]> } {
		const data: Json = {};
		const taxonomies: Record<string, string[]> = {};
		if (plan.hasTitle && typeof item["title"] === "string" && item["title"] !== "") data["title"] = item["title"];
		for (const b of plan.bindings) {
			const v = item[`${plan.handle}__${b.handle}`];
			if (b.kind === "taxonomy") {
				const slugs = list(v).map((c) => (isObject(c) ? c["slug"] : null)).filter((s): s is string => typeof s === "string");
				if (slugs.length) taxonomies[b.slug] = [...(taxonomies[b.slug] ?? []), ...slugs];
				continue;
			}
			const value = this.value(b, v, scope);
			if (value !== null && value !== undefined) data[b.slug] = value;
		}
		for (const slug of this.required.get(scope) ?? []) {
			if (!(slug in data)) this.missing.set(`${scope}.${slug}`, (this.missing.get(`${scope}.${slug}`) ?? 0) + 1);
		}
		return { data, taxonomies };
	}

	// ---- reading a site ---------------------------------------------------------------------------------------

	private async readCollection(
		collection: Plan["collections"][number],
		query: string,
		report: (fetched: number, count: number) => void,
	): Promise<SeedContentEntry[]> {
		const { execute, pageSize = 100, seed, project } = this.opts;
		const counted = await execute(`query Count($section: [String]) { entryCount(section: $section, site: ["*"], status: ${STATUSES}) }`, {
			section: [collection.section],
		});
		const count = typeof counted.data["entryCount"] === "number" ? counted.data["entryCount"] : 0;
		report(0, count);
		const rows: Json[] = [];
		for (let offset = 0; ; offset += pageSize) {
			const { data, errors } = await execute(query, { section: [collection.section], limit: pageSize, offset });
			if (!Array.isArray(data["entries"])) {
				// the whole list failed, not one field of it: an empty section in the seed would hide that
				throw new Error(`Craft could not read section ${collection.section}: ${errors.map((e) => e.message).join("; ") || "no entries in the response"}`);
			}
			for (const error of errors) {
				// path is e.g. ["entries", 3, "seo"]: report the field once, not once per entry
				const field = (error.path ?? []).filter((p) => typeof p === "string").slice(1).join(" > ") || "query";
				this.note("decide", "graphql_error", `section ${collection.section} > ${field}`, `Craft answered with an error, so these values are missing: ${error.message}`);
			}
			const page = list(data["entries"]).filter(isObject);
			rows.push(...page);
			report(rows.length, Math.max(count, rows.length));
			if (page.length < pageSize) break;
		}

		const multiSite = project.sites.length > 1;
		const primary = seed.defaultLocale;
		const byId = new Map<string, Json[]>();
		for (const row of rows) byId.set(String(row["id"]), [...(byId.get(String(row["id"])) ?? []), row]);

		const entries: SeedContentEntry[] = [];
		const seen = new Set<string>();
		for (const [id, versions] of byId) {
			// the primary site's version is the one the others translate
			versions.sort((a, b) => Number(b["language"] === primary) - Number(a["language"] === primary));
			versions.forEach((row, i) => {
				const plan = collection.entryTypes.find((p) => p.handle === row["typeHandle"]);
				if (!plan) return;
				const locale = typeof row["language"] === "string" ? row["language"] : primary;
				let slug = typeof row["slug"] === "string" && row["slug"] !== "" ? row["slug"] : `entry-${id}`;
				const { data, taxonomies } = this.entryData(plan, row, `collection:${collection.slug}`);
				if (collection.discriminator) data["entry_type"] = plan.handle;
				if (seen.has(`${slug}|${locale}`)) {
					// EmDash keys entries by collection, slug and locale: a second entry with the same slug would replace the first
					this.note("decide", "duplicate_slug", `section ${collection.section} > slug ${slug}`, `Several entries share this slug. Entry ${id} is imported as ${slug}-${id}; rename it or remove the duplicate.`);
					slug = `${slug}-${id}`;
				}
				seen.add(`${slug}|${locale}`);
				entries.push({
					id: i === 0 ? `craft-${id}` : `craft-${id}-${locale}`,
					slug,
					status: row["status"] === "live" ? "published" : "draft",
					...(multiSite ? { locale } : {}),
					...(i > 0 ? { translationOf: `craft-${id}` } : {}),
					data,
					...(Object.keys(taxonomies).length ? { taxonomies } : {}),
				});
			});
		}
		return entries;
	}

	private async readTerms(group: string): Promise<SeedTaxonomyTerm[]> {
		const primary = this.opts.project.sites.find((s) => s.primary) ?? this.opts.project.sites[0];
		const { data } = await this.opts.execute(
			`query Terms($group: [String], $site: [String]) { categories(group: $group, site: $site, orderBy: "lft asc") { slug title parent { slug } } }`,
			{ group: [group], site: primary ? [primary.handle] : null },
		);
		return list(data["categories"])
			.filter(isObject)
			.filter((c) => typeof c["slug"] === "string" && c["slug"] !== "")
			.map((c): SeedTaxonomyTerm => {
				const parent = isObject(c["parent"]) ? c["parent"]["slug"] : undefined;
				return {
					slug: String(c["slug"]),
					label: typeof c["title"] === "string" && c["title"] ? c["title"] : String(c["slug"]),
					...(typeof parent === "string" ? { parent } : {}),
				};
			});
	}

	private async readGlobals(): Promise<Record<string, SeedContentEntry[]>> {
		const { plan, seed, project, execute } = this.opts;
		const readable = plan.globals.filter((g) => this.types.fields.has(g.plan.gqlType));
		for (const g of plan.globals) {
			if (!readable.includes(g)) this.note("decide", "not_readable", `global set ${g.plan.handle}`, "Craft's GraphQL schema does not include this global set, so it is not read. With --endpoint, give the token's schema access to it.");
		}
		if (readable.length === 0 || !this.types.fields.get("Query")?.has("globalSets")) return {};

		const fragments = readable.map((g) => this.entryFragment(g.plan)).join(" ");
		const { data } = await execute(`{ globalSets(site: ["*"]) { handle language ${fragments} } }`);
		const multiSite = project.sites.length > 1;
		const content: Record<string, SeedContentEntry[]> = {};
		for (const g of readable) {
			const versions = list(data["globalSets"]).filter(isObject).filter((row) => row["handle"] === g.plan.handle);
			versions.sort((a, b) => Number(b["language"] === seed.defaultLocale) - Number(a["language"] === seed.defaultLocale));
			const entries = versions.map((row, i): SeedContentEntry => {
				const locale = typeof row["language"] === "string" ? row["language"] : seed.defaultLocale;
				const { data: values, taxonomies } = this.entryData(g.plan, row, `collection:${g.slug}`);
				return {
					id: i === 0 ? `global-${g.plan.handle}` : `global-${g.plan.handle}-${locale}`,
					status: "published",
					...(multiSite ? { locale } : {}),
					...(i > 0 ? { translationOf: `global-${g.plan.handle}` } : {}),
					data: values,
					...(Object.keys(taxonomies).length ? { taxonomies } : {}),
				};
			});
			if (entries.length) content[g.slug] = entries;
		}
		return content;
	}

	/** Retour's static redirects, where its GraphQL query is available. EmDash redirects are exact, local paths. */
	private async readRedirects(): Promise<SeedRedirect[]> {
		if (!this.types.fields.get("Query")?.has("retourRedirects")) return [];
		const { data } = await this.opts.execute("{ retourRedirects { redirectSrcUrl redirectDestUrl redirectHttpCode redirectMatchType enabled } }");
		const local = (path: unknown): path is string =>
			typeof path === "string" && /^\/(?!\/)/.test(path) && !/[\r\n]/.test(path) && !path.split(/[/?#]/).includes("..");
		const redirects = new Map<string, SeedRedirect>();
		const skipped = new Map<string, string[]>();
		const skip = (reason: string, source: unknown): void => void skipped.set(reason, [...(skipped.get(reason) ?? []), String(source)]);

		for (const row of list(data["retourRedirects"]).filter(isObject)) {
			const raw = row["redirectSrcUrl"];
			const source = typeof raw === "string" && raw !== "" && !raw.startsWith("/") && !/^[a-z]+:/i.test(raw) ? `/${raw}` : raw;
			const code = row["redirectHttpCode"];
			if (row["redirectMatchType"] !== "exactmatch") skip("it matches by pattern, and EmDash redirects match one exact path", raw);
			else if (!local(source)) skip("its source is not a path on this site", raw);
			else if (!local(row["redirectDestUrl"])) skip("it points to another site, and EmDash redirects stay on the site", raw);
			else if (typeof code !== "number" || !REDIRECT_CODES.has(code)) skip(`its status code is ${String(code)}, and EmDash allows 301, 302, 307 and 308`, raw);
			else if (redirects.has(source)) skip("another redirect already has this source", raw);
			else {
				redirects.set(source, {
					source,
					destination: row["redirectDestUrl"] as string,
					type: code as SeedRedirect["type"],
					enabled: row["enabled"] !== false,
					groupName: "Craft (Retour)",
				});
			}
		}
		for (const [reason, sources] of skipped) {
			const shown = sources.slice(0, 10).join(", ");
			this.note("decide", "redirect_skipped", `${sources.length} ${sources.length === 1 ? "redirect" : "redirects"}: ${reason.split(",")[0]}`, `Not converted because ${reason}: ${shown}${sources.length > 10 ? `, and ${sources.length - 10} more` : ""}. Recreate these in EmDash or at your host.`);
		}
		return [...redirects.values()];
	}

	/** Collections that others reference come first: EmDash resolves a `$ref:` only to an entry created earlier. */
	private ordered(collections: Plan["collections"]): Plan["collections"] {
		const targets = new Map<string, Set<string>>();
		for (const c of this.opts.seed.collections) {
			const set = new Set<string>();
			for (const f of c.fields) {
				const target = f.type === "reference" ? f.validation?.["targetCollection"] : undefined;
				if (typeof target !== "string") continue;
				if (target === c.slug) this.note("info", "self_reference", `collection ${c.slug} > field ${f.slug}`, "Entries link to others in the same collection. EmDash skips a link to an entry that comes later in the seed; apply the seed twice with --on-conflict update to fill them in.");
				else set.add(target);
			}
			targets.set(c.slug, set);
		}
		const out: Plan["collections"] = [];
		const state = new Map<string, "visiting" | "done">();
		const visit = (slug: string): void => {
			if (state.has(slug)) return; // done, or a cycle: whichever is reached first goes first
			state.set(slug, "visiting");
			for (const target of targets.get(slug) ?? []) visit(target);
			state.set(slug, "done");
			const plan = collections.find((c) => c.slug === slug);
			if (plan) out.push(plan);
		};
		for (const c of collections) visit(c.slug);
		return out;
	}

	/**
	 * Craft only enforces "required" when an entry is saved live, so real content has gaps: drafts, disabled entries,
	 * entries older than the rule. EmDash rejects the whole seed over one such gap, so a required field that some
	 * content leaves empty is made optional, and the report says which.
	 */
	private relaxRequired(seed: SeedFile): SeedFile {
		if (this.missing.size === 0) return seed;
		const out = structuredClone(seed);
		const relax = (scope: string, where: string, fields: Array<SeedField | RepeaterSubField>): void => {
			for (const f of fields) {
				const n = this.missing.get(`${scope}.${f.slug}`);
				if (!n || !f.required) continue;
				delete f.required;
				this.note("info", "required_relaxed", `${where} > field ${f.slug}`, `Required in Craft, but ${n} ${n === 1 ? "item has" : "items have"} no value, so the field is optional in the seed. Fill the gaps, then make it required again.`);
			}
		};
		for (const c of out.collections) relax(`collection:${c.slug}`, `collection ${c.slug}`, c.fields);
		for (const b of out.blockTypes ?? []) {
			const fields = b.versions[0]?.fields ?? [];
			relax(`block:${b.slug}`, `block ${b.slug}`, fields);
			for (const f of fields) {
				const subFields = f.type === "repeater" ? f.validation?.["subFields"] : undefined;
				if (Array.isArray(subFields)) relax(`row:${b.slug}.${f.slug}`, `block ${b.slug} > field ${f.slug}`, subFields as RepeaterSubField[]);
			}
		}
		return out;
	}

	async run(): Promise<ContentResult> {
		const { plan, seed, sections, onProgress } = this.opts;
		const wanted = sections ? plan.collections.filter((c) => sections.includes(c.section)) : plan.collections;
		for (const handle of sections ?? []) {
			if (!plan.collections.some((c) => c.section === handle)) throw new Error(`No section "${handle}" in this Craft project`);
		}

		const { checkpointDir, resume } = this.opts;
		if (checkpointDir) mkdirSync(checkpointDir, { recursive: true });
		const content: Record<string, SeedContentEntry[]> = {};
		const ordered = this.ordered(wanted);
		for (const [i, planned] of ordered.entries()) {
			const at = { section: planned.section, index: i + 1, total: ordered.length };
			// With --endpoint, a token whose schema lacks a section makes Craft answer with nothing rather than an error.
			const visible = planned.entryTypes.filter((t) => this.types.fields.has(t.gqlType));
			for (const t of planned.entryTypes) {
				if (!visible.includes(t)) this.note("decide", "not_readable", `section ${planned.section} > entry type ${t.handle}`, "Craft's GraphQL schema does not include this entry type, so its entries are not read. With --endpoint, give the token's schema access to the section.");
			}
			if (visible.length === 0) {
				onProgress?.({ ...at, fetched: 0, count: 0, state: "done" });
				continue;
			}
			const collection = { ...planned, entryTypes: visible };
			const query = this.entriesQuery(collection.entryTypes);
			// a checkpoint is only good for the queries that made it: a changed content model reads the section again
			const key = createHash("sha256").update(CHECKPOINT_VERSION).update(query).update(String(this.opts.baseUrl)).digest("hex");
			const file = checkpointDir ? join(checkpointDir, `${collection.slug}.json`) : undefined;

			let saved: Checkpoint | undefined;
			if (resume && file && existsSync(file)) {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
				if (parsed.key === key) saved = parsed;
			}
			if (saved) {
				for (const n of saved.notes) this.note(n.level, n.code, n.where, n.message);
				for (const [k, n] of saved.missing) this.missing.set(k, (this.missing.get(k) ?? 0) + n);
				for (const host of saved.assetHosts) this.assetHosts.add(host);
				onProgress?.({ ...at, fetched: saved.entries.length, count: saved.entries.length, state: "resumed" });
			} else {
				const notesBefore = this.notes.length;
				const missingBefore = new Map(this.missing);
				this.sectionHosts = new Set();
				const entries = await this.readCollection(collection, query, (fetched, count) => onProgress?.({ ...at, fetched, count, state: "reading" }));
				const missing = [...this.missing].filter(([k]) => !missingBefore.has(k) || missingBefore.get(k) !== this.missing.get(k));
				saved = {
					key,
					entries,
					notes: this.notes.slice(notesBefore),
					missing: missing.map(([k, n]) => [k, n - (missingBefore.get(k) ?? 0)]),
					assetHosts: [...this.sectionHosts],
				};
				if (file) writeFileSync(file, JSON.stringify(saved));
				onProgress?.({ ...at, fetched: entries.length, count: entries.length, state: "done" });
			}
			if (saved.entries.length) content[collection.slug] = saved.entries;
		}

		const hasCategories = this.types.fields.get("Query")?.has("categories") === true;
		const taxonomies = await Promise.all(
			(seed.taxonomies ?? []).map(async (taxonomy) => {
				const group = plan.taxonomies.find((t) => t.name === taxonomy.name)?.group;
				const terms = group && hasCategories ? await this.readTerms(group) : [];
				return terms.length ? { ...taxonomy, terms } : taxonomy;
			}),
		);

		// --sections asks for those sections only
		let redirects: SeedRedirect[] = [];
		if (!sections) {
			const globals = await this.readGlobals();
			Object.assign(content, globals);
			if (plan.globals.length) this.opts.onMessage?.(`global sets  ${Object.keys(globals).length} of ${plan.globals.length}`);
			redirects = await this.readRedirects();
			if (redirects.length || this.notes.some((n) => n.code === "redirect_skipped")) this.opts.onMessage?.(`redirects  ${redirects.length}`);
		}

		return {
			seed: {
				...this.relaxRequired(seed),
				...(taxonomies.length ? { taxonomies } : {}),
				content,
				...(redirects.length ? { redirects } : {}),
			},
			notes: this.notes,
			assetHosts: [...this.assetHosts].sort(),
		};
	}
}

interface Checkpoint {
	key: string;
	entries: SeedContentEntry[];
	notes: Note[];
	missing: Array<[string, number]>;
	assetHosts: string[];
}

export async function readContent(opts: ContentOptions): Promise<ContentResult> {
	const types = await introspect(opts.execute);
	if (!types.fields.get("Query")?.has("entries")) {
		throw new Error("Craft's GraphQL schema has no `entries` query: the token's schema cannot read entries.");
	}
	return new ContentReader(opts, types).run();
}
