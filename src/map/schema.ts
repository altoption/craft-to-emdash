// Maps a Craft project's content model onto an EmDash seed: sections become collections, Matrix fields become
// blocks fields, nested entry types become block types, category groups become taxonomies.
//
// Nothing is dropped. A field with no EmDash equivalent is kept as JSON (a `json` field in a collection, a `text`
// field holding JSON inside a block, where EmDash allows no `json`) and listed in the notes for a person to decide.
import type { CraftEntryType, CraftField, CraftProject, CraftSection } from "../craft/load.ts";
import type {
	FieldType,
	RepeaterSubField,
	SeedBlockType,
	SeedCollection,
	SeedField,
	SeedFile,
	SeedTaxonomy,
} from "../seed/types.ts";

export type NoteLevel = "info" | "decide";

export interface Note {
	level: NoteLevel;
	code: string;
	/** Where in the Craft project, e.g. "section pages > field pageBuilder". */
	where: string;
	message: string;
}

/** How the content pass reads one Craft field and writes it into the seed. */
export type BindingKind =
	| "scalar"
	| "link"
	| "richtext"
	| "image"
	| "file"
	| "images"
	| "reference"
	| "taxonomy"
	| "blocks"
	| "repeater"
	| "children"
	| "raw";

export interface Binding {
	/** Seed field slug; for a taxonomy, the taxonomy name. */
	slug: string;
	/** Field handle in Craft's GraphQL API. */
	handle: string;
	fieldUid: string;
	kind: BindingKind;
	/** Raw values inside a block are stored as a JSON string, since EmDash blocks allow no json field. */
	rawAsText?: boolean;
	/**
	 * Matrix entry types: block types for "blocks", the single row type for "repeater", and for "children" the
	 * block types of nested entries that are written after their parent block rather than inside it.
	 */
	entryTypeUids?: string[];
}

export interface EntryPlan {
	uid: string;
	handle: string;
	/** The GraphQL object type Craft generates for it: `<handle>_Entry`, or `<handle>_GlobalSet`. */
	gqlType: string;
	hasTitle: boolean;
	bindings: Binding[];
}

export interface CollectionPlan {
	slug: string;
	section: string;
	/** True when several entry types share the collection and `entry_type` tells them apart. */
	discriminator: boolean;
	entryTypes: EntryPlan[];
}

export interface Plan {
	collections: CollectionPlan[];
	/**
	 * Block types by Craft entry type uid. `belongsTo` names the field that records which parent a nested block
	 * follows, present only when its position alone would not say.
	 */
	blocks: Record<string, EntryPlan & { slug: string; belongsTo?: string }>;
	/** Repeater row shapes by Craft entry type uid. */
	rows: Record<string, EntryPlan>;
	/** Global sets, each a collection holding one entry. */
	globals: Array<{ slug: string; plan: EntryPlan }>;
	taxonomies: Array<{ name: string; group: string }>;
}

export interface SchemaResult {
	seed: SeedFile;
	notes: Note[];
	plan: Plan;
}

/** Where a field sits decides which EmDash field types it may use. */
type Context = "collection" | "block" | "repeater";

type Mapped = Pick<SeedField, "type" | "validation" | "defaultValue"> & Pick<Binding, "kind" | "entryTypeUids">;

/** A nested Matrix whose entries become blocks of their own, listed after the block that held them. */
interface Children {
	children: string[];
}

/** What a plugin's presence means for the migration. Anything not listed has no known EmDash counterpart. */
const PLUGIN_ADVICE: Record<string, string> = {
	ckeditor: "Rich text is converted to Portable Text.",
	redactor: "Rich text is converted to Portable Text.",
	seomatic: "Per-entry SEO values are kept as JSON. Turn on `seo` for the collections that need it and map titles and descriptions by hand.",
	retour: "The content pass reads Retour's static redirects into the seed. Regular-expression redirects are listed for you to recreate.",
	freeform: "Forms and submissions are not converted. Rebuild the forms with EmDash's forms plugin.",
	formie: "Forms and submissions are not converted. Rebuild the forms with EmDash's forms plugin.",
	"feed-me": "Feed definitions are not converted; imported entries are ordinary entries and come across with the content.",
	sprig: "Template behaviour, not content. Rebuild the interactive parts in Astro.",
	"craft-cloud": "Hosting integration; nothing to convert.",
	cloud: "Hosting integration; nothing to convert.",
};

const RESERVED = new Set([
	"id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at",
	"scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "terms", "bylines", "byline",
]);
const REPEATER_TYPES = new Set<FieldType>([
	"string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image",
]);
const BLOCK_TYPES = new Set<FieldType>([...REPEATER_TYPES, "multiSelect", "portableText", "file", "repeater"]);
const MAX_BLOCKS = 100;

/** `pageBuilder` -> `page_builder`: lowercase letters, digits and underscores, starting with a letter. */
export function toSlug(handle: string): string {
	const slug = handle
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.toLowerCase()
		.replace(/^_+|_+$/g, "");
	return /^[a-z]/.test(slug) ? slug : `c_${slug}`;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const shortType = (type: string): string => type.split("\\").pop() ?? type;

/** Option values of a Dropdown, RadioButtons, Checkboxes or MultiSelect field (optgroup headings have none). */
function optionValues(settings: Record<string, unknown>): string[] {
	return list(settings["options"])
		.map((o) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)["value"] : undefined))
		.filter((v): v is string => typeof v === "string" && v !== "");
}

function uidsOf(value: unknown): string[] {
	return list(value)
		.map((e) => (typeof e === "string" ? e : typeof e === "object" && e !== null ? (e as Record<string, unknown>)["uid"] : undefined))
		.filter((v): v is string => typeof v === "string");
}

class SchemaMapper {
	readonly notes: Note[] = [];
	private readonly blockTypes = new Map<string, SeedBlockType>();
	private readonly blockSlugByUid = new Map<string, string>();
	private readonly collectionSlugBySection = new Map<string, string>();
	private readonly taxonomyCollections = new Map<string, Set<string>>();
	private readonly blockPlans: Plan["blocks"] = {};
	private readonly rowPlans: Plan["rows"] = {};
	private readonly collectionPlans: CollectionPlan[] = [];
	private readonly globalPlans: Plan["globals"] = [];
	/** Counts fallbacks, so a trial mapping can tell whether it was clean. */
	private fallbacks = 0;

	private readonly project: CraftProject;

	constructor(project: CraftProject) {
		this.project = project;
		for (const section of project.sections) this.collectionSlugBySection.set(section.uid, toSlug(section.handle));
	}

	private note(level: NoteLevel, code: string, where: string, message: string): void {
		this.notes.push({ level, code, where, message });
	}

	private fallback(ctx: Context, field: CraftField, where: string, reason: string): Mapped {
		this.fallbacks++;
		const plugin = !field.type.startsWith("craft\\");
		this.note(
			"decide",
			plugin ? "plugin_field" : "no_equivalent",
			where,
			`${shortType(field.type)}${plugin ? " (plugin field)" : ""}: ${reason} Kept as ${ctx === "collection" ? "a json field" : "JSON in a text field"}.`,
		);
		return { type: ctx === "collection" ? "json" : "text", kind: "raw" };
	}

	/** The EmDash type for a Craft field, or the taxonomy name when the field becomes a taxonomy instead of a field. */
	private mapType(field: CraftField, ctx: Context, where: string, collection: string | undefined): Mapped | Children | string {
		const s = field.settings;
		switch (field.type) {
			case "craft\\fields\\PlainText": {
				const maxLength = num(s["charLimit"]);
				return { kind: "scalar", type: s["multiline"] === true ? "text" : "string", ...(maxLength ? { validation: { maxLength } } : {}) };
			}
			case "craft\\fields\\Email":
			case "craft\\fields\\Color":
			case "craft\\fields\\Time":
			case "craft\\fields\\Icon":
				return { kind: "scalar", type: "string" };
			case "craft\\fields\\Url":
				return { kind: "scalar", type: "url" };
			case "craft\\fields\\Link": {
				const types = list(s["types"]);
				if (types.some((t) => t !== "url")) {
					this.note("info", "link_types", where, `Link field allows ${types.join(", ")}; the content pass stores each link as its resolved URL.`);
				}
				return { kind: "link", type: "url" };
			}
			case "craft\\fields\\Number":
			case "craft\\fields\\Range":
			case "craft\\fields\\Money": {
				const validation: Record<string, unknown> = {};
				const min = num(s["min"]);
				const max = num(s["max"]);
				if (min !== undefined) validation["min"] = min;
				if (max !== undefined) validation["max"] = max;
				const integer = field.type === "craft\\fields\\Number" && !num(s["decimals"]);
				return { kind: "scalar", type: integer ? "integer" : "number", ...(Object.keys(validation).length ? { validation } : {}) };
			}
			case "craft\\fields\\Lightswitch":
				return { kind: "scalar", type: "boolean", defaultValue: s["default"] === true };
			case "craft\\fields\\Dropdown":
			case "craft\\fields\\RadioButtons":
			case "craft\\fields\\ButtonGroup":
				return { kind: "scalar", type: "select", validation: { options: optionValues(s) } };
			case "craft\\fields\\Checkboxes":
			case "craft\\fields\\MultiSelect":
				if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold a multiple-choice field.");
				return { kind: "scalar", type: "multiSelect", validation: { options: optionValues(s) } };
			case "craft\\fields\\Date":
				return { kind: "scalar", type: "datetime" };
			case "craft\\ckeditor\\Field":
			case "craft\\redactor\\Field":
				if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold rich text.");
				if (uidsOf(s["entryTypes"]).length > 0) {
					this.note("decide", "richtext_nested_entries", where, "This rich text field embeds nested entries; they have no place in Portable Text yet and need a custom block.");
				}
				return { kind: "richtext", type: "portableText" };
			case "craft\\fields\\Assets":
				return this.mapAssets(field, ctx, where);
			case "craft\\fields\\Entries":
				return this.mapEntries(field, ctx, where);
			case "craft\\fields\\Categories": {
				const group = typeof s["source"] === "string" ? s["source"].replace(/^group:/, "") : "";
				if (ctx === "collection" && collection && this.project.categoryGroups.has(group)) {
					const set = this.taxonomyCollections.get(group) ?? new Set<string>();
					set.add(collection);
					this.taxonomyCollections.set(group, set);
					return toSlug(this.project.categoryGroups.get(group)?.handle ?? group);
				}
				return this.fallback(ctx, field, where, "categories can only be assigned to a whole entry, not to a block inside it.");
			}
			case "craft\\fields\\Matrix":
				return this.mapMatrix(field, ctx, where);
			default:
				return this.fallback(ctx, field, where, "no EmDash field type matches it.");
		}
	}

	private mapAssets(field: CraftField, ctx: Context, where: string): Mapped {
		const s = field.settings;
		const kinds = list(s["allowedKinds"]);
		const imagesOnly = s["restrictFiles"] === true && kinds.length === 1 && kinds[0] === "image";
		const max = num(s["maxRelations"]);
		if (max === 1) {
			if (imagesOnly) return { kind: "image", type: "image" };
			if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold a file.");
			return { kind: "file", type: "file" };
		}
		if (imagesOnly && ctx !== "repeater") {
			const subFields: RepeaterSubField[] = [{ slug: "image", label: "Image", type: "image", required: true }];
			return { kind: "images", type: "repeater", validation: { subFields, ...(max ? { maxItems: max } : {}) } };
		}
		return this.fallback(ctx, field, where, "EmDash has no field for several files.");
	}

	private mapEntries(field: CraftField, ctx: Context, where: string): Mapped {
		if (ctx !== "collection") return this.fallback(ctx, field, where, "a block cannot hold a reference to another entry.");
		const sources = field.settings["sources"];
		const sections = list(sources).map((src) => (typeof src === "string" ? src.replace(/^section:/, "") : ""));
		const target = sections.length === 1 ? this.collectionSlugBySection.get(sections[0] ?? "") : undefined;
		if (!target) {
			return this.fallback(ctx, field, where, "a reference field targets one collection, and this field allows entries from several sections.");
		}
		return { kind: "reference", type: "reference", validation: { targetCollection: target, multiple: num(field.settings["maxRelations"]) !== 1 } };
	}

	/** The block types that can follow these ones as their flattened children, at any depth. */
	private descendants(uids: string[]): string[] {
		const seen = new Set(uids);
		const out: string[] = [];
		const queue = [...uids];
		for (let uid = queue.shift(); uid !== undefined; uid = queue.shift()) {
			for (const b of this.blockPlans[uid]?.bindings ?? []) {
				if (b.kind !== "children") continue;
				for (const child of b.entryTypeUids ?? []) {
					if (seen.has(child)) continue;
					seen.add(child);
					out.push(child);
					queue.push(child);
				}
			}
		}
		return out;
	}

	private mapMatrix(field: CraftField, ctx: Context, where: string): Mapped | Children {
		const s = field.settings;
		const uids = uidsOf(s["entryTypes"]);
		const min = num(s["minEntries"]);
		const max = num(s["maxEntries"]);
		const limits = { ...(min ? { minItems: min } : {}), ...(max ? { maxItems: max } : {}) };

		if (ctx === "collection") {
			const direct = uids.map((uid) => this.blockSlug(uid));
			// nested entries that are flattened sit in this same list, so the field must allow their types too
			const nested = this.descendants(uids).map((uid) => this.blockSlug(uid));
			// Craft's limit counts top-level entries only; once nested ones share the list it no longer means the same
			const cap = max && nested.length === 0 ? { maxItems: Math.min(max, MAX_BLOCKS) } : {};
			if (max && max > MAX_BLOCKS) this.note("info", "blocks_limit", where, `Craft allows ${max} entries; EmDash blocks fields hold at most ${MAX_BLOCKS}.`);
			return {
				kind: "blocks",
				entryTypeUids: uids,
				type: "blocks",
				validation: { allowedTypes: [...direct, ...nested], ...(min ? { minItems: min } : {}), ...cap },
			};
		}
		if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold a list of entries.");

		// EmDash blocks cannot nest. A nested Matrix with one entry type of simple fields fits a repeater.
		const entryType = uids.length === 1 ? this.project.entryTypes.get(uids[0] ?? "") : undefined;
		if (entryType) {
			const subFields = this.trySubFields(entryType, `${where} > entry type ${entryType.handle}`);
			if (subFields) return { kind: "repeater", entryTypeUids: [entryType.uid], type: "repeater", validation: { subFields, ...limits } };
		}
		// Anything richer is flattened: each nested entry becomes a block of its own, written after its parent.
		const slugs = uids.map((uid) => this.blockSlug(uid));
		this.note("info", "flattened", where, `EmDash blocks cannot hold other blocks. Its entries become ${slugs.join(", ")} blocks placed directly after the block they belonged to; group them by position in your templates.`);
		return { children: uids };
	}

	/** Maps an entry type as repeater rows; null (and no notes) when any of its fields does not fit. */
	private trySubFields(entryType: CraftEntryType, where: string): RepeaterSubField[] | null {
		const notesBefore = this.notes.length;
		const fallbacksBefore = this.fallbacks;
		const { fields, plan } = this.layoutFields(entryType, "repeater", where, undefined);
		const clean = this.fallbacks === fallbacksBefore && fields.length > 0 && fields.every((f) => REPEATER_TYPES.has(f.type));
		if (!clean) {
			this.notes.length = notesBefore;
			this.fallbacks = fallbacksBefore;
			return null;
		}
		this.rowPlans[entryType.uid] = plan;
		return fields.map((f): RepeaterSubField => {
			const options = f.type === "select" ? f.validation?.["options"] : undefined;
			return {
				slug: f.slug,
				label: f.label,
				type: f.type,
				...(f.required ? { required: true } : {}),
				...(Array.isArray(options) ? { options: options as string[] } : {}),
			};
		});
	}

	/** The block type for a nested entry type, created on first use. */
	private blockSlug(uid: string): string {
		const known = this.blockSlugByUid.get(uid);
		if (known) return known;
		const entryType = this.project.entryTypes.get(uid);
		const slug = toSlug(entryType?.handle ?? uid);
		this.blockSlugByUid.set(uid, slug);
		if (!entryType) {
			this.note("decide", "missing_entry_type", `entry type ${uid}`, "A Matrix field names an entry type that is not in the project config.");
			return slug;
		}
		// Reserved before its fields are mapped: a nested entry type mapped on the way is then listed after it, and an
		// entry type that nests itself finds its own slug instead of recursing.
		const blockType: SeedBlockType = { slug, label: entryType.name, currentVersion: 1, versions: [{ version: 1, fields: [] }] };
		this.blockTypes.set(slug, blockType);
		const { fields, plan } = this.layoutFields(entryType, "block", `block ${entryType.handle}`, undefined);
		this.blockPlans[uid] = { ...plan, slug };
		blockType.versions = [{ version: 1, fields }];
		return slug;
	}

	private layoutFields(
		entryType: CraftEntryType,
		ctx: Context,
		where: string,
		collection: string | undefined,
		gqlType = `${entryType.handle}_Entry`,
	): { fields: SeedField[]; plan: EntryPlan } {
		const out: SeedField[] = [];
		const plan: EntryPlan = { uid: entryType.uid, handle: entryType.handle, gqlType, hasTitle: false, bindings: [] };
		const used = new Set<string>();
		const multiSite = this.project.sites.length > 1;

		for (const el of entryType.elements) {
			if (el.type.endsWith("\\EntryTitleField")) {
				used.add("title");
				plan.hasTitle = true;
				out.push({ slug: "title", label: el.label ?? "Title", type: "string", required: true });
				continue;
			}
			if (!el.fieldUid) continue; // headings, tips, line breaks and other layout-only elements
			const field = this.project.fields.get(el.fieldUid);
			if (!field) {
				this.note("decide", "missing_field", where, `The layout names field ${el.fieldUid}, which is not in the project config.`);
				continue;
			}
			const handle = el.handle ?? field.handle;
			const fieldWhere = `${where} > field ${handle}`;
			const result = this.mapType(field, ctx, fieldWhere, collection);
			if (typeof result === "string") {
				plan.bindings.push({ slug: result, handle, fieldUid: field.uid, kind: "taxonomy" });
				continue;
			}
			if ("children" in result) {
				let slot = toSlug(handle);
				while (used.has(slot)) slot = `${slot}_2`;
				used.add(slot);
				plan.bindings.push({ slug: slot, handle, fieldUid: field.uid, kind: "children", entryTypeUids: result.children });
				continue;
			}
			const { kind, entryTypeUids, ...mapped } = result;

			let slug = toSlug(handle);
			if (RESERVED.has(slug)) {
				this.note("info", "reserved_slug", fieldWhere, `"${slug}" is reserved in EmDash; the field is named craft_${slug}.`);
				slug = `craft_${slug}`;
			}
			while (used.has(slug)) slug = `${slug}_2`;
			used.add(slug);

			const allowed = ctx === "collection" || (ctx === "block" ? BLOCK_TYPES : REPEATER_TYPES).has(mapped.type);
			if (!allowed) throw new Error(`${fieldWhere}: mapped to ${mapped.type}, which EmDash does not allow in a ${ctx}`);

			plan.bindings.push({
				slug,
				handle,
				fieldUid: field.uid,
				kind,
				...(kind === "raw" && ctx !== "collection" ? { rawAsText: true } : {}),
				...(entryTypeUids ? { entryTypeUids } : {}),
			});
			out.push({
				slug,
				label: el.label ?? field.name,
				...mapped,
				// a blocks field is always optional in EmDash
				...(el.required && mapped.type !== "blocks" ? { required: true } : {}),
				...(multiSite && field.translationMethod === "none" && ctx === "collection" ? { translatable: false } : {}),
			});
		}
		return { fields: out, plan };
	}

	private collection(section: CraftSection, primarySite: string | undefined): SeedCollection {
		const slug = toSlug(section.handle);
		const where = `section ${section.handle}`;
		const entryTypes = section.entryTypeUids
			.map((uid) => this.project.entryTypes.get(uid))
			.filter((et): et is CraftEntryType => et !== undefined);

		const fields: SeedField[] = [];
		if (entryTypes.length > 1) {
			this.note("info", "merged_entry_types", where, `Its ${entryTypes.length} entry types share one collection; the entry_type field says which one an entry is.`);
			fields.push({
				slug: "entry_type",
				label: "Entry type",
				type: "select",
				required: true,
				validation: { options: entryTypes.map((et) => et.handle) },
			});
		}
		const plans: EntryPlan[] = [];
		for (const entryType of entryTypes) {
			const layout = this.layoutFields(entryType, "collection", `${where} > entry type ${entryType.handle}`, slug);
			plans.push(layout.plan);
			for (const field of layout.fields) {
				const existing = fields.find((f) => f.slug === field.slug);
				// a field only some entry types have cannot be required of every entry
				const merged = entryTypes.length > 1 && field.slug !== "title" ? { ...field, required: undefined } : field;
				if (merged.required === undefined) delete merged.required;
				if (!existing) fields.push(merged);
				else if (existing.type !== merged.type) {
					const renamed = `${field.slug}_${toSlug(entryType.handle)}`;
					this.note("info", "field_type_clash", `${where} > field ${field.slug}`, `Entry types disagree on its type; ${entryType.handle}'s is named ${renamed}.`);
					fields.push({ ...merged, slug: renamed });
					const binding = layout.plan.bindings.find((b) => b.slug === field.slug && b.kind !== "taxonomy");
					if (binding) binding.slug = renamed;
				}
			}
		}

		this.collectionPlans.push({ slug, section: section.handle, discriminator: entryTypes.length > 1, entryTypes: plans });

		const out: SeedCollection = {
			slug,
			label: section.name,
			...(entryTypes.length === 1 && entryTypes[0] ? { labelSingular: entryTypes[0].name } : {}),
			supports: ["drafts", ...(section.enableVersioning ? ["revisions"] : [])],
			...(fields.some((f) => f.slug === "title") ? { titleField: "title" } : {}),
			fields,
		};

		const uri = primarySite ? section.uriFormats[primarySite] : undefined;
		if (section.type === "single") {
			this.note("info", "single_section", where, `A single becomes a collection with one entry${uri ? ` (Craft URI: ${uri})` : ""}; route it in your Astro pages.`);
		} else if (uri) {
			const simple = /^[^{}]*\{slug\}[^{}]*$/.test(uri);
			if (simple) out.urlPattern = `/${uri.replace(/^\/+/, "")}`;
			else this.note("decide", "uri_format", where, `Its URI format "${uri}" uses more than {slug}; set the collection's urlPattern by hand.`);
		}
		return out;
	}

	/**
	 * A flattened child is found by position: it follows its parent. That stops being enough when the same block type
	 * can also stand on its own in the list, or hangs off two fields of one parent. Those types get a `belongs_to`
	 * field saying which parent field each one came from.
	 */
	private markAmbiguousChildren(): void {
		const standalone = new Set<string>();
		for (const plan of [...this.collectionPlans.flatMap((c) => c.entryTypes), ...this.globalPlans.map((g) => g.plan)]) {
			for (const b of plan.bindings) if (b.kind === "blocks") for (const uid of b.entryTypeUids ?? []) standalone.add(uid);
		}
		const slots = new Map<string, Array<{ parent: string; slot: string }>>();
		for (const [parentUid, parent] of Object.entries(this.blockPlans)) {
			for (const b of parent.bindings) {
				if (b.kind !== "children") continue;
				for (const child of b.entryTypeUids ?? []) {
					slots.set(child, [...(slots.get(child) ?? []), { parent: parentUid, slot: `${parent.slug}.${b.slug}` }]);
				}
			}
		}
		for (const [uid, places] of slots) {
			const plan = this.blockPlans[uid];
			const fields = this.blockTypes.get(plan?.slug ?? "")?.versions[0]?.fields;
			if (!plan || !fields) continue;
			const parents = places.map((p) => p.parent);
			const ambiguous = standalone.has(uid) || new Set(parents).size < parents.length || parents.includes(uid);
			if (!ambiguous) continue;
			let slug = "belongs_to";
			while (fields.some((f) => f.slug === slug)) slug = `${slug}_2`;
			fields.push({ slug, label: "Belongs to", type: "select", validation: { options: places.map((p) => p.slot) } });
			plan.belongsTo = slug;
			this.note("info", "belongs_to", `block ${plan.handle}`, `This block can stand alone or follow a parent block, so position alone does not say which. Its ${slug} field names the parent field (${places.map((p) => p.slot).join(", ")}); it is empty on a block that stands alone.`);
		}
	}

	/** EmDash has no global sets. Each becomes a collection without URLs, holding the one entry. */
	private globalSet(set: CraftEntryType, taken: Set<string>): SeedCollection {
		let slug = `global_${toSlug(set.handle)}`;
		while (taken.has(slug)) slug = `${slug}_2`;
		const where = `global set ${set.handle}`;
		const { fields, plan } = this.layoutFields(set, "collection", where, slug, `${set.handle}_GlobalSet`);
		this.globalPlans.push({ slug, plan });
		this.note("info", "global_set", where, `EmDash has no global sets. It becomes the collection ${slug}, holding one entry; read it in your templates with getEmDashCollection("${slug}").`);
		return { slug, label: set.name, routable: false, supports: ["revisions"], fields };
	}

	run(): SchemaResult {
		const primary = this.project.sites.find((s) => s.primary) ?? this.project.sites[0];
		const collections = this.project.sections.map((section) => this.collection(section, primary?.uid));
		const taken = new Set(collections.map((c) => c.slug));
		for (const set of this.project.globalSets) collections.push(this.globalSet(set, taken));

		const taxonomies = [...this.project.categoryGroups.values()].map((group): SeedTaxonomy => {
			const used = [...(this.taxonomyCollections.get(group.uid) ?? [])].sort();
			if (used.length === 0) this.note("info", "unused_category_group", `category group ${group.handle}`, "No section's entries use it directly, so the taxonomy is attached to no collection.");
			return { name: toSlug(group.handle), label: group.name, hierarchical: group.maxLevels !== 1, collections: used };
		});

		if (this.project.sites.length > 1) {
			const locales = this.project.sites.map((s) => s.language).join(", ");
			this.note("info", "locales", "sites", `Add these locales to the EmDash site's i18n configuration before importing content: ${locales}.`);
		}

		this.markAmbiguousChildren();

		for (const plugin of this.project.plugins) {
			const advice = PLUGIN_ADVICE[plugin.handle];
			this.note(
				advice ? "info" : "decide",
				"plugin",
				`plugin ${plugin.handle}${plugin.enabled ? "" : " (disabled)"}`,
				advice ?? "No EmDash counterpart is known. Its settings and any data it stores are not converted.",
			);
		}

		const { name, timeZone } = this.project.system;
		const settings = { ...(name ? { title: name } : {}), ...(timeZone ? { timezone: timeZone } : {}) };
		const blockTypes = [...this.blockTypes.values()];
		const seed: SeedFile = {
			$schema: "https://emdashcms.com/seed.schema.json",
			version: "1",
			defaultLocale: primary?.language ?? "en",
			meta: { name: "Imported from Craft CMS", description: "Content model converted by craft-to-emdash" },
			...(Object.keys(settings).length ? { settings } : {}),
			...(blockTypes.length ? { blockTypes } : {}),
			collections,
			...(taxonomies.length ? { taxonomies } : {}),
		};
		const plan: Plan = {
			collections: this.collectionPlans,
			blocks: this.blockPlans,
			rows: this.rowPlans,
			globals: this.globalPlans,
			taxonomies: [...this.project.categoryGroups.values()].map((g) => ({ name: toSlug(g.handle), group: g.handle })),
		};
		return { seed, notes: this.notes, plan };
	}
}

export function mapSchema(project: CraftProject): SchemaResult {
	return new SchemaMapper(project).run();
}
