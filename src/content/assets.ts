// Downloads the assets a seed refers to and points the seed at the local copies.
//
// By default a seed names each asset by URL and EmDash fetches it when the seed is applied. EmDash refuses local and
// private addresses, and a site being retired may not stay online, so the files can be fetched here instead and
// referenced as `$media.file`, which EmDash reads from the seed's folder.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Note } from "../map/schema.ts";
import type { SeedFile } from "../seed/types.ts";

export interface AssetOptions {
	/** The folder seed.json is written to; assets go in its `assets` subfolder. */
	outDir: string;
	fetch?: typeof fetch;
	concurrency?: number;
	attempts?: number;
	onProgress?: (done: number, total: number) => void;
}

type MediaRef = { url?: string | null; file?: string | null; filename?: string };

/** Every `$media` reference in the seed that names a URL. */
function mediaRefs(value: unknown, found: MediaRef[] = []): MediaRef[] {
	if (Array.isArray(value)) for (const v of value) mediaRefs(v, found);
	else if (typeof value === "object" && value !== null) {
		const media = (value as Record<string, unknown>)["$media"];
		if (typeof media === "object" && media !== null && typeof (media as MediaRef).url === "string") found.push(media as MediaRef);
		else for (const v of Object.values(value)) mediaRefs(v, found);
	}
	return found;
}

/**
 * A file name that is safe on any system and unique per URL. EmDash takes the MIME type from the extension, so the
 * original name is kept; the hash keeps two different files called `hero.jpg` apart.
 */
function localName(url: string, filename: string | undefined): string {
	let name = filename;
	if (!name) {
		try {
			name = decodeURIComponent(basename(new URL(url).pathname));
		} catch {
			name = undefined;
		}
	}
	const safe = (name || "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "asset";
	return `${createHash("sha1").update(url).digest("hex").slice(0, 8)}-${safe}`;
}

async function download(url: string, target: string, opts: Required<Pick<AssetOptions, "fetch" | "attempts">>): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await opts.fetch(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length === 0) throw new Error("the file is empty");
			// written under another name first, so a download cut short is never mistaken for a finished one
			writeFileSync(`${target}.part`, bytes);
			renameSync(`${target}.part`, target);
			return;
		} catch (error) {
			if (attempt >= opts.attempts) throw error;
			await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
		}
	}
}

export async function downloadAssets(seed: SeedFile, options: AssetOptions): Promise<{ seed: SeedFile; notes: Note[] }> {
	const out = structuredClone(seed);
	const refs = mediaRefs(out);
	const urls = [...new Set(refs.map((r) => r.url as string))];
	const dir = join(options.outDir, "assets");
	const opts = { fetch: options.fetch ?? fetch, attempts: options.attempts ?? 3 };
	mkdirSync(dir, { recursive: true });

	const files = new Map<string, string>();
	const failed = new Map<string, string>();
	let done = 0;
	const queue = [...urls];
	const worker = async (): Promise<void> => {
		for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
			const name = localName(url, refs.find((r) => r.url === url)?.filename);
			const target = join(dir, name);
			try {
				// a file already there was finished by an earlier run
				if (!existsSync(target) || statSync(target).size === 0) await download(url, target, opts);
				files.set(url, `assets/${name}`);
			} catch (error) {
				failed.set(url, error instanceof Error ? error.message : String(error));
			}
			options.onProgress?.(++done, urls.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 6, urls.length) }, worker));

	for (const ref of refs) {
		const file = files.get(ref.url as string);
		if (!file) continue;
		ref.file = file;
		delete ref.url;
	}

	const notes: Note[] = [];
	if (failed.size) {
		const shown = [...failed].slice(0, 10).map(([url, why]) => `${url} (${why})`).join(", ");
		notes.push({
			level: "decide",
			code: "asset_not_downloaded",
			where: `${failed.size} of ${urls.length} assets`,
			message: `Could not be downloaded, so the seed still names them by URL and EmDash will try to fetch them when it is applied: ${shown}${failed.size > 10 ? `, and ${failed.size - 10} more` : ""}.`,
		});
	}
	return { seed: out, notes };
}
