// Reads a Craft CMS 5 project config folder (config/project) into plain objects.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface CraftField {
	uid: string;
	handle: string;
	name: string;
	type: string;
	settings: Record<string, unknown>;
	translationMethod: string;
}

export interface LayoutElement {
	/** Craft class name, e.g. craft\fieldlayoutelements\CustomField */
	type: string;
	fieldUid?: string;
	/** Per-layout overrides; null means "use the field's own". */
	handle: string | null;
	label: string | null;
	required: boolean;
}

export interface CraftEntryType {
	uid: string;
	handle: string;
	name: string;
	elements: LayoutElement[];
}

export interface CraftSection {
	uid: string;
	handle: string;
	name: string;
	type: "single" | "channel" | "structure";
	entryTypeUids: string[];
	enableVersioning: boolean;
	/** URI format per site uid; null when the section has no URLs on that site. */
	uriFormats: Record<string, string | null>;
}

export interface CraftSite {
	uid: string;
	handle: string;
	name: string;
	language: string;
	primary: boolean;
}

export interface CraftCategoryGroup {
	uid: string;
	handle: string;
	name: string;
	maxLevels: number | null;
}

export interface CraftProject {
	sites: CraftSite[];
	sections: CraftSection[];
	entryTypes: Map<string, CraftEntryType>;
	fields: Map<string, CraftField>;
	categoryGroups: Map<string, CraftCategoryGroup>;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const dict = (v: unknown): Dict => (isDict(v) ? v : {});
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/**
 * Craft writes ordered maps as `{ __assoc__: [[key, value], ...] }` so that key order survives YAML.
 * Turn them back into plain objects, at every depth.
 */
export function unpackAssoc(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(unpackAssoc);
	if (!isDict(value)) return value;
	const packed = value["__assoc__"];
	if (Array.isArray(packed) && Object.keys(value).length === 1) {
		const out: Dict = {};
		for (const pair of packed) {
			if (Array.isArray(pair) && pair.length === 2) out[String(pair[0])] = unpackAssoc(pair[1]);
		}
		return out;
	}
	const out: Dict = {};
	for (const [k, v] of Object.entries(value)) out[k] = unpackAssoc(v);
	return out;
}

/** Accepts the project root or the config/project folder itself. */
export function resolveConfigDir(path: string): string {
	const nested = join(path, "config", "project");
	const dir = existsSync(join(nested, "project.yaml")) ? nested : path;
	if (!existsSync(join(dir, "project.yaml"))) {
		throw new Error(`${path} is not a Craft project: no project.yaml in it or in its config/project folder`);
	}
	if (!existsSync(join(dir, "entryTypes"))) {
		throw new Error(
			`${dir} has no entryTypes folder. craft-to-emdash reads Craft 5 project config; upgrade the project to Craft 5 first.`,
		);
	}
	return dir;
}

/** Every `<handle>--<uid>.yaml` (or `<uid>.yaml`) file in a subfolder, as [uid, contents]. */
function readFolder(dir: string, folder: string): Array<[string, Dict]> {
	const path = join(dir, folder);
	if (!existsSync(path) || !statSync(path).isDirectory()) return [];
	return readdirSync(path)
		.filter((name) => name.endsWith(".yaml"))
		.sort()
		.map((name): [string, Dict] => {
			const uid = name.slice(0, -".yaml".length).split("--").pop() ?? "";
			return [uid, dict(unpackAssoc(parse(readFileSync(join(path, name), "utf8"))))];
		});
}

/** The first (in practice only) field layout's elements, across its tabs, in order. */
function layoutElements(config: Dict): LayoutElement[] {
	const layout = Object.values(dict(config["fieldLayouts"]))[0];
	const tabs = dict(layout)["tabs"];
	if (!Array.isArray(tabs)) return [];
	return tabs.flatMap((tab) => {
		const elements = dict(tab)["elements"];
		if (!Array.isArray(elements)) return [];
		return elements.map((raw): LayoutElement => {
			const el = dict(raw);
			return {
				type: str(el["type"]),
				...(typeof el["fieldUid"] === "string" ? { fieldUid: el["fieldUid"] } : {}),
				handle: typeof el["handle"] === "string" ? el["handle"] : null,
				label: typeof el["label"] === "string" && el["label"] !== "__blank__" ? el["label"] : null,
				required: el["required"] === true,
			};
		});
	});
}

export function loadCraftProject(path: string): CraftProject {
	const dir = resolveConfigDir(path);

	const sites = readFolder(dir, "sites").map(
		([uid, c]): CraftSite => ({
			uid,
			handle: str(c["handle"]),
			name: str(c["name"]),
			language: str(c["language"], "en"),
			primary: c["primary"] === true,
		}),
	);

	const sections = readFolder(dir, "sections").map(([uid, c]): CraftSection => {
		const entryTypes = Array.isArray(c["entryTypes"]) ? c["entryTypes"] : [];
		const uriFormats: Record<string, string | null> = {};
		for (const [siteUid, raw] of Object.entries(dict(c["siteSettings"]))) {
			const s = dict(raw);
			uriFormats[siteUid] = s["hasUrls"] === false ? null : typeof s["uriFormat"] === "string" ? s["uriFormat"] : null;
		}
		const type = str(c["type"], "channel");
		return {
			uid,
			handle: str(c["handle"]),
			name: str(c["name"]),
			type: type === "single" || type === "structure" ? type : "channel",
			entryTypeUids: entryTypes.map((e) => (typeof e === "string" ? e : str(dict(e)["uid"]))).filter(Boolean),
			enableVersioning: c["enableVersioning"] !== false,
			uriFormats,
		};
	});

	const entryTypes = new Map(
		readFolder(dir, "entryTypes").map(([uid, c]): [string, CraftEntryType] => [
			uid,
			{ uid, handle: str(c["handle"]), name: str(c["name"]), elements: layoutElements(c) },
		]),
	);

	const fields = new Map(
		readFolder(dir, "fields").map(([uid, c]): [string, CraftField] => [
			uid,
			{
				uid,
				handle: str(c["handle"]),
				name: str(c["name"]),
				type: str(c["type"]),
				settings: dict(c["settings"]),
				translationMethod: str(c["translationMethod"], "none"),
			},
		]),
	);

	const categoryGroups = new Map(
		readFolder(dir, "categoryGroups").map(([uid, c]): [string, CraftCategoryGroup] => {
			const maxLevels = dict(c["structure"])["maxLevels"];
			return [
				uid,
				{ uid, handle: str(c["handle"]), name: str(c["name"]), maxLevels: typeof maxLevels === "number" ? maxLevels : null },
			];
		}),
	);

	return { sites, sections, entryTypes, fields, categoryGroups };
}
