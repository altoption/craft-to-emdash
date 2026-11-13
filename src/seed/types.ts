// The parts of EmDash's seed format (version "1") that this tool writes.
// Reference: https://docs.emdashcms.com/themes/seed-files/

export type FieldType =
	| "string"
	| "text"
	| "url"
	| "slug"
	| "number"
	| "integer"
	| "boolean"
	| "datetime"
	| "select"
	| "multiSelect"
	| "portableText"
	| "json"
	| "repeater"
	| "blocks"
	| "image"
	| "file"
	| "reference";

export interface RepeaterSubField {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	options?: string[];
}

export interface SeedField {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	translatable?: boolean;
	defaultValue?: unknown;
	validation?: Record<string, unknown>;
}

export interface SeedBlockType {
	slug: string;
	label: string;
	currentVersion: number;
	versions: Array<{ version: number; fields: SeedField[] }>;
}

export interface SeedCollection {
	slug: string;
	label: string;
	labelSingular?: string;
	supports?: string[];
	urlPattern?: string;
	/** False for a collection whose entries have no public URL of their own, such as a Craft global set. */
	routable?: boolean;
	titleField?: string;
	fields: SeedField[];
}

export interface SeedTaxonomy {
	name: string;
	label: string;
	hierarchical: boolean;
	collections: string[];
	terms?: SeedTaxonomyTerm[];
}

export interface SeedTaxonomyTerm {
	slug: string;
	label: string;
	parent?: string;
}

export interface SeedContentEntry {
	id: string;
	/** Omitted for an entry in a collection that is not routable. */
	slug?: string;
	status: "published" | "draft";
	locale?: string;
	translationOf?: string;
	data: Record<string, unknown>;
	taxonomies?: Record<string, string[]>;
}

export interface SeedRedirect {
	source: string;
	destination: string;
	type: 301 | 302 | 307 | 308;
	enabled: boolean;
	groupName: string;
}

export interface SeedFile {
	$schema: string;
	version: "1";
	defaultLocale: string;
	meta: { name: string; description: string };
	settings?: { title?: string; timezone?: string };
	blockTypes?: SeedBlockType[];
	collections: SeedCollection[];
	taxonomies?: SeedTaxonomy[];
	content?: Record<string, SeedContentEntry[]>;
	redirects?: SeedRedirect[];
}
