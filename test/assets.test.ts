import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downloadAssets } from "../src/index.ts";
import type { SeedFile } from "../src/index.ts";

const media = (url: string, extra: Record<string, unknown> = {}) => ({ $media: { url, ...extra } });
const seed = (): SeedFile => ({
	$schema: "",
	version: "1",
	defaultLocale: "en",
	meta: { name: "", description: "" },
	collections: [],
	content: {
		posts: [
			{
				id: "a",
				slug: "a",
				status: "published",
				data: {
					hero: media("https://cdn.example/img/hero.jpg", { filename: "hero.jpg", alt: "Hero" }),
					// the same file used twice, and another file with the same name
					again: media("https://cdn.example/img/hero.jpg", { filename: "hero.jpg" }),
					other: media("https://cdn.example/other/hero.jpg", { filename: "hero.jpg" }),
					body: [{ _type: "image", asset: media("https://cdn.example/img/in%20line.png?v=2") }],
					gone: media("https://cdn.example/missing.pdf", { filename: "missing.pdf" }),
				},
			},
		],
	},
});

function fakeFetch(): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fake = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		return url.includes("missing") ? new Response("no", { status: 404 }) : new Response(`bytes of ${url}`);
	};
	return { fetch: fake as typeof fetch, calls };
}

describe("downloading assets", () => {
	it("saves each file once and points the seed at it, keeping what it could not fetch as a URL", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "c2e-assets-"));
		const { fetch, calls } = fakeFetch();
		const original = seed();
		const { seed: out, notes } = await downloadAssets(original, { outDir, fetch, attempts: 1 });
		const data = out.content?.["posts"]?.[0]?.data as Record<string, { $media: Record<string, string> }>;

		expect(data["hero"]?.$media).toEqual({ file: expect.stringMatching(/^assets\/[0-9a-f]{8}-hero\.jpg$/), filename: "hero.jpg", alt: "Hero" });
		expect(data["again"]?.$media["file"]).toBe(data["hero"]?.$media["file"]);
		expect(data["other"]?.$media["file"]).not.toBe(data["hero"]?.$media["file"]);
		const inline = (data["body"] as unknown as Array<{ asset: { $media: Record<string, string> } }>)[0]?.asset.$media;
		expect(inline).toEqual({ file: expect.stringMatching(/^assets\/[0-9a-f]{8}-in-line\.png$/) });
		expect(data["gone"]?.$media).toEqual({ url: "https://cdn.example/missing.pdf", filename: "missing.pdf" });

		// the paths in the seed are files, relative to the seed's folder
		expect(readFileSync(join(outDir, data["hero"]?.$media["file"] ?? ""), "utf8")).toBe("bytes of https://cdn.example/img/hero.jpg");
		expect(readdirSync(join(outDir, "assets"))).toHaveLength(3);
		expect(calls.filter((u) => u === "https://cdn.example/img/hero.jpg")).toHaveLength(1);

		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({ code: "asset_not_downloaded", where: "1 of 4 assets" });
		expect(notes[0]?.message).toContain("https://cdn.example/missing.pdf (HTTP 404)");
		// the seed passed in is left as it was
		expect((original.content?.["posts"]?.[0]?.data["hero"] as { $media: { url: string } }).$media.url).toBe("https://cdn.example/img/hero.jpg");
	});

	it("does not fetch a file an earlier run already saved", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "c2e-assets-"));
		await downloadAssets(seed(), { outDir, fetch: fakeFetch().fetch, attempts: 1 });
		const second = fakeFetch();
		const progress: string[] = [];
		await downloadAssets(seed(), { outDir, fetch: second.fetch, attempts: 1, onProgress: (d, t) => progress.push(`${d}/${t}`) });
		expect(second.calls).toEqual(["https://cdn.example/missing.pdf"]);
		expect(progress.at(-1)).toBe("4/4");
		expect(existsSync(join(outDir, "assets"))).toBe(true);
	});
});
