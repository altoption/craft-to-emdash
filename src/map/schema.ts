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

export interface SchemaResult {
	seed: SeedFile;
	notes: Note[];
}

/** Where a field sits decides which EmDash field types it may use. */
type Context = "collection" | "block" | "repeater";

type Mapped = Pick<SeedField, "type" | "validation" | "defaultValue">;

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
		return { type: ctx === "collection" ? "json" : "text" };
	}

	/** The EmDash type for a Craft field, or null when the field becomes something other than a field (a taxonomy). */
	private mapType(field: CraftField, ctx: Context, where: string, collection: string | undefined): Mapped | null {
		const s = field.settings;
		switch (field.type) {
			case "craft\\fields\\PlainText": {
				const maxLength = num(s["charLimit"]);
				return { type: s["multiline"] === true ? "text" : "string", ...(maxLength ? { validation: { maxLength } } : {}) };
			}
			case "craft\\fields\\Email":
			case "craft\\fields\\Color":
			case "craft\\fields\\Time":
			case "craft\\fields\\Icon":
				return { type: "string" };
			case "craft\\fields\\Url":
				return { type: "url" };
			case "craft\\fields\\Link": {
				const types = list(s["types"]);
				if (types.some((t) => t !== "url")) {
					this.note("info", "link_types", where, `Link field allows ${types.join(", ")}; the content pass stores each link as its resolved URL.`);
				}
				return { type: "url" };
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
				return { type: integer ? "integer" : "number", ...(Object.keys(validation).length ? { validation } : {}) };
			}
			case "craft\\fields\\Lightswitch":
				return { type: "boolean", defaultValue: s["default"] === true };
			case "craft\\fields\\Dropdown":
			case "craft\\fields\\RadioButtons":
			case "craft\\fields\\ButtonGroup":
				return { type: "select", validation: { options: optionValues(s) } };
			case "craft\\fields\\Checkboxes":
			case "craft\\fields\\MultiSelect":
				if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold a multiple-choice field.");
				return { type: "multiSelect", validation: { options: optionValues(s) } };
			case "craft\\fields\\Date":
				return { type: "datetime" };
			case "craft\\ckeditor\\Field":
			case "craft\\redactor\\Field":
				if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold rich text.");
				if (uidsOf(s["entryTypes"]).length > 0) {
					this.note("decide", "richtext_nested_entries", where, "This rich text field embeds nested entries; they have no place in Portable Text yet and need a custom block.");
				}
				return { type: "portableText" };
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
					return null;
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
			if (imagesOnly) return { type: "image" };
			if (ctx === "repeater") return this.fallback(ctx, field, where, "a repeater row cannot hold a file.");
			return { type: "file" };
		}
		if (imagesOnly && ctx !== "repeater") {
			const subFields: RepeaterSubField[] = [{ slug: "image", label: "Image", type: "image", required: true }];
			return { type: "repeater", validation: { subFields, ...(max ? { maxItems: max } : {}) } };
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
		return { type: "reference", validation: { targetCollection: target, multiple: num(field.settings["maxRelations"]) !== 1 } };
	}

	private mapMatrix(field: CraftField, ctx: Context, where: string): Mapped {
		const s = field.settings;
		const uids = uidsOf(s["entryTypes"]);
		const min = num(s["minEntries"]);
		const max = num(s["maxEntries"]);
		const limits = { ...(min ? { minItems: min } : {}), ...(max ? { maxItems: max } : {}) };

		if (ctx === "collection") {
			if (max && max > MAX_BLOCKS) this.note("info", "blocks_limit", where, `Craft allows ${max} entries; EmDash blocks fields hold at most ${MAX_BLOCKS}.`);
			return {
				type: "blocks",
				validation: { allowedTypes: uids.map((uid) => this.blockSlug(uid)), ...limits, ...(max ? { maxItems: Math.min(max, MAX_BLOCKS) } : {}) },
			};
		}
		// EmDash blocks cannot nest. A nested Matrix with one entry type of simple fields fits a repeater.
		const entryType = uids.length === 1 ? this.project.entryTypes.get(uids[0] ?? "") : undefined;
		if (ctx === "block" && entryType) {
			const subFields = this.trySubFields(entryType, `${where} > entry type ${entryType.handle}`);
			if (subFields) return { type: "repeater", validation: { subFields, ...limits } };
		}
		return this.fallback(ctx, field, where, "EmDash blocks cannot contain other blocks, and its nested entries are too rich for a repeater.");
	}

	/** Maps an entry type as repeater rows; null (and no notes) when any of its fields does not fit. */
	private trySubFields(entryType: CraftEntryType, where: string): RepeaterSubField[] | null {
		const notesBefore = this.notes.length;
		const fallbacksBefore = this.fallbacks;
		const fields = this.layoutFields(entryType, "repeater", where, undefined);
		const clean = this.fallbacks === fallbacksBefore && fields.length > 0 && fields.every((f) => REPEATER_TYPES.has(f.type));
		if (!clean) {
			this.notes.length = notesBefore;
			this.fallbacks = fallbacksBefore;
			return null;
		}
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
		const fields = this.layoutFields(entryType, "block", `block ${entryType.handle}`, undefined);
		this.blockTypes.set(slug, { slug, label: entryType.name, currentVersion: 1, versions: [{ version: 1, fields }] });
		return slug;
	}

	private layoutFields(entryType: CraftEntryType, ctx: Context, where: string, collection: string | undefined): SeedField[] {
		const out: SeedField[] = [];
		const used = new Set<string>();
		const multiSite = this.project.sites.length > 1;

		for (const el of entryType.elements) {
			if (el.type.endsWith("\\EntryTitleField")) {
				used.add("title");
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
			const mapped = this.mapType(field, ctx, fieldWhere, collection);
			if (!mapped) continue;

			let slug = toSlug(handle);
			if (RESERVED.has(slug)) {
				this.note("info", "reserved_slug", fieldWhere, `"${slug}" is reserved in EmDash; the field is named craft_${slug}.`);
				slug = `craft_${slug}`;
			}
			while (used.has(slug)) slug = `${slug}_2`;
			used.add(slug);

			const allowed = ctx === "collection" || (ctx === "block" ? BLOCK_TYPES : REPEATER_TYPES).has(mapped.type);
			if (!allowed) throw new Error(`${fieldWhere}: mapped to ${mapped.type}, which EmDash does not allow in a ${ctx}`);

			out.push({
				slug,
				label: el.label ?? field.name,
				...mapped,
				// a blocks field is always optional in EmDash
				...(el.required && mapped.type !== "blocks" ? { required: true } : {}),
				...(multiSite && field.translationMethod === "none" && ctx === "collection" ? { translatable: false } : {}),
			});
		}
		return out;
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
		for (const entryType of entryTypes) {
			for (const field of this.layoutFields(entryType, "collection", `${where} > entry type ${entryType.handle}`, slug)) {
				const existing = fields.find((f) => f.slug === field.slug);
				// a field only some entry types have cannot be required of every entry
				const merged = entryTypes.length > 1 && field.slug !== "title" ? { ...field, required: undefined } : field;
				if (merged.required === undefined) delete merged.required;
				if (!existing) fields.push(merged);
				else if (existing.type !== merged.type) {
					const renamed = `${field.slug}_${toSlug(entryType.handle)}`;
					this.note("info", "field_type_clash", `${where} > field ${field.slug}`, `Entry types disagree on its type; ${entryType.handle}'s is named ${renamed}.`);
					fields.push({ ...merged, slug: renamed });
				}
			}
		}

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

	run(): SchemaResult {
		const primary = this.project.sites.find((s) => s.primary) ?? this.project.sites[0];
		const collections = this.project.sections.map((section) => this.collection(section, primary?.uid));

		const taxonomies = [...this.project.categoryGroups.values()].map((group): SeedTaxonomy => {
			const used = [...(this.taxonomyCollections.get(group.uid) ?? [])].sort();
			if (used.length === 0) this.note("info", "unused_category_group", `category group ${group.handle}`, "No section's entries use it directly, so the taxonomy is attached to no collection.");
			return { name: toSlug(group.handle), label: group.name, hierarchical: group.maxLevels !== 1, collections: used };
		});

		if (this.project.sites.length > 1) {
			const locales = this.project.sites.map((s) => s.language).join(", ");
			this.note("info", "locales", "sites", `Add these locales to the EmDash site's i18n configuration before importing content: ${locales}.`);
		}

		const blockTypes = [...this.blockTypes.values()];
		const seed: SeedFile = {
			$schema: "https://emdashcms.com/seed.schema.json",
			version: "1",
			defaultLocale: primary?.language ?? "en",
			meta: { name: "Imported from Craft CMS", description: "Content model converted by craft-to-emdash" },
			...(blockTypes.length ? { blockTypes } : {}),
			collections,
			...(taxonomies.length ? { taxonomies } : {}),
		};
		return { seed, notes: this.notes };
	}
}

export function mapSchema(project: CraftProject): SchemaResult {
	return new SchemaMapper(project).run();
}
