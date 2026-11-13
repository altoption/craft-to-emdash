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
					moved: media("https://cdn.example/moved.jpg", { filename: "moved.jpg" }),
					notes: [
						// addresses that did not come from an asset field: one on the machine's own network, one that is not http
						{ _type: "image", asset: media("http://169.254.169.254/latest/meta-data/") },
						{ _type: "image", asset: media("file:///etc/passwd") },
					],
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
		if (url.includes("moved")) return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/internal" } });
		return url.includes("missing") ? new Response("no", { status: 404 }) : new Response(`bytes of ${url}`);
	};
	return { fetch: fake as typeof fetch, calls };
}

describe("downloading assets", () => {
	it("saves each file once and points the seed at it, keeping what it could not fetch as a URL", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "c2e-assets-"));
		const { fetch, calls } = fakeFetch();
		const original = seed();
		const { seed: out, notes } = await downloadAssets(original, { outDir, hosts: ["cdn.example"], fetch, attempts: 1 });
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
		expect(notes[0]).toMatchObject({ code: "asset_not_downloaded", where: "4 of 7 assets" });
		expect(notes[0]?.message).toContain("https://cdn.example/missing.pdf (HTTP 404)");

		// only the asset fields' own host is ever requested, including after a redirect
		expect(calls.every((u) => u.startsWith("https://cdn.example/"))).toBe(true);
		expect(notes[0]?.message).toContain("http://169.254.169.254/latest/meta-data/ (not one of the site's asset hosts)");
		expect(notes[0]?.message).toContain("file:///etc/passwd (not one of the site's asset hosts)");
		expect(notes[0]?.message).toContain("https://cdn.example/moved.jpg (redirects to 10.0.0.5)");
		const refused = data["notes"] as unknown as Array<{ asset: { $media: Record<string, string> } }>;
		expect(refused.map((b) => b.asset.$media)).toEqual([{ url: "http://169.254.169.254/latest/meta-data/" }, { url: "file:///etc/passwd" }]);
		// the seed passed in is left as it was
		expect((original.content?.["posts"]?.[0]?.data["hero"] as { $media: { url: string } }).$media.url).toBe("https://cdn.example/img/hero.jpg");
	});

	it("downloads nothing from a host the asset fields did not use, wherever the address sits in the seed", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "c2e-assets-"));
		const { fetch, calls } = fakeFetch();
		// a field-shaped reference to an internal address, as a hand-edited or hostile seed could hold
		const hostile = seed();
		(hostile.content?.["posts"]?.[0]?.data as Record<string, unknown>)["hero"] = media("http://10.0.0.5/admin");
		const { notes } = await downloadAssets(hostile, { outDir, hosts: ["cdn.example"], fetch, attempts: 1 });
		expect(calls.some((u) => u.includes("10.0.0.5"))).toBe(false);
		expect(notes[0]?.message).toContain("http://10.0.0.5/admin (not one of the site's asset hosts)");
	});

	it("does not fetch a file an earlier run already saved", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "c2e-assets-"));
		await downloadAssets(seed(), { outDir, hosts: ["cdn.example"], fetch: fakeFetch().fetch, attempts: 1 });
		const second = fakeFetch();
		const progress: string[] = [];
		await downloadAssets(seed(), { outDir, hosts: ["cdn.example"], fetch: second.fetch, attempts: 1, onProgress: (d, t) => progress.push(`${d}/${t}`) });
		expect(second.calls.sort()).toEqual(["https://cdn.example/missing.pdf", "https://cdn.example/moved.jpg"]);
		expect(progress.at(-1)).toBe("7/7");
		expect(existsSync(join(outDir, "assets"))).toBe(true);
	});
});
