// CKEditor/Redactor HTML to EmDash-flavoured Portable Text, using EmDash's own converter so the dialect matches.
import { htmlToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The converter's keys are random. Renumber them in document order so the same HTML always gives the same output,
 * keeping the marks that point at a link definition in step with it.
 */
function rekey(blocks: unknown[]): void {
	const renamed = new Map<string, string>();
	let n = 0;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(visit);
		if (!isNode(value)) return;
		if (typeof value["_key"] === "string") {
			const key = `k${++n}`;
			renamed.set(value["_key"], key);
			value["_key"] = key;
		}
		for (const child of Object.values(value)) visit(child);
	};
	const remark = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(remark);
		if (!isNode(value)) return;
		if (Array.isArray(value["marks"])) value["marks"] = value["marks"].map((m) => renamed.get(String(m)) ?? m);
		for (const child of Object.values(value)) remark(child);
	};
	visit(blocks);
	remark(blocks);
}

/** Point every image at a `$media` reference, so applying the seed downloads it into EmDash's media library. */
function mediaRefs(value: unknown, resolveUrl: (url: string) => string): void {
	if (Array.isArray(value)) return value.forEach((v) => mediaRefs(v, resolveUrl));
	if (!isNode(value)) return;
	const asset = value["asset"];
	if (value["_type"] === "image" && isNode(asset) && typeof asset["url"] === "string") {
		const alt = typeof value["alt"] === "string" && value["alt"] ? { alt: value["alt"] } : {};
		value["asset"] = { $media: { url: resolveUrl(asset["url"]), ...alt } };
	}
	for (const child of Object.values(value)) mediaRefs(child, resolveUrl);
}

export function htmlToBlocks(html: string, resolveUrl: (url: string) => string): unknown[] | null {
	if (html.trim() === "") return null;
	const blocks = htmlToPortableText(html) as unknown[];
	rekey(blocks);
	mediaRefs(blocks, resolveUrl);
	return blocks.length ? blocks : null;
}
