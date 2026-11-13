# craft-to-emdash

Convert a [Craft CMS](https://craftcms.com) 5 project into an [EmDash](https://github.com/emdash-cms/emdash) seed file.

Status: early, and not yet published to npm. Both passes work and have been run against a real Craft 5 site, with the
result applied to a fresh EmDash database.

## Use

```bash
# the content model only: needs no running site
npx craft-to-emdash schema path/to/craft-project --out out

# the content model and the content
npx craft-to-emdash content path/to/craft-project --craft "ddev craft" --out out
```

Both write:

- `out/seed.json`: an EmDash seed (format `1`).
- `out/report.md`: what was converted, and every place a person has to decide something.

Then, in an EmDash project:

```bash
npx emdash seed out/seed.json --validate
npx emdash seed out/seed.json
```

### Reading content

The content pass reads entries through Craft's GraphQL API. Pick how it reaches Craft:

| Option | When | What it needs |
| --- | --- | --- |
| `--craft "<console command>"` | You have a working copy of the site | Craft's console: `php craft`, `ddev craft`, … Nothing to set up in Craft. |
| `--endpoint <url>` | You only have the live site | A GraphQL schema that can read every section, and its token in `CRAFT_GQL_TOKEN` |

`--craft` runs each query inside Craft against a full-access schema, so it sees every section and status without a
schema or token being created. Either way the tool only reads: every request is parsed before it is sent, and
anything other than a single query is refused.

Other options:

- `--sections blog,pages` reads only those sections.
- `--base-url https://example.com` resolves assets Craft serves with root-relative URLs.
- `--page-size 50` sets how many entries each request asks for.
- `--timeout 600` sets how many seconds one request may take (default 300).
- `--download-assets` saves every asset into `out/assets/` and points the seed at those files.
- `--resume` continues an interrupted run, including assets already downloaded.

Progress is printed per section. Each finished section is saved under `out/.checkpoints/`, a failed request is tried
three times, and `--resume` reuses what an earlier run finished. `seed.json` and the checkpoints hold your content,
unpublished entries included: treat them like a database backup.

## What this assumes about your setup

The tool checks what it can and says so when something is off, but it cannot check everything:

- **Craft 5, with project config on disk.** It reads `config/project/`, so that folder must match the database you
  read content from. Run `craft project-config/write` first if you are unsure.
- **`--craft` needs a console that works from the project root.** Give the exact command you would type there:
  `php craft`, `ddev craft`, `docker compose exec -T php php craft`. A long query is sent through standard input, so
  a container command must forward it (`docker exec -i`).
- **`--endpoint` needs a schema that can read everything you want.** Craft answers a token that lacks a section with
  nothing, not with an error. The report lists each section and global set the schema does not include; a section
  missing from the report was read.
- **Assets have to be reachable by something.** By default the seed names each asset by URL and EmDash fetches it
  when the seed is applied. EmDash refuses local and private addresses, so that fails for assets served from a
  development machine (`*.ddev.site`, `localhost`). `--download-assets` fetches them from the machine running this
  tool instead and writes them next to the seed; keep `seed.json` and `assets/` together when you move them. An asset
  that cannot be downloaded stays a URL in the seed and is listed in the report. Only the hosts your asset fields
  point at are requested: an image address typed into rich text on any other host is left as a URL.
- **`emdash seed` writes to a local SQLite database.** For a site on Cloudflare D1, apply the seed locally and move
  it with EmDash's site transfer, or use the seed at setup.
- **Locales exist in EmDash first.** A multi-site Craft project needs each language added to the EmDash site's i18n
  configuration before its content is applied. The report lists them.
- **Node 22.18 or later** on the machine running this tool.

## What becomes what

| Craft | EmDash |
| --- | --- |
| Section | Collection (several entry types share it, told apart by an `entry_type` field) |
| Matrix field on an entry | `blocks` field |
| Nested entry type | Block type |
| Matrix inside a block, one entry type of simple fields | `repeater` |
| Plain Text, Number, Lightswitch, Dropdown, Date, Link | `string`/`text`, `integer`/`number`, `boolean`, `select`, `datetime`, `url` |
| CKEditor | `portableText` |
| Assets | `image`, `file`, or a repeater of images |
| Entries (one source section) | `reference` |
| Categories | Taxonomy on the collection, with its terms |
| Sites | Locales; an entry's other sites become its translations |
| Global set | Collection without URLs, holding one entry |
| Retour static redirects | Redirects |
| System name and time zone | Site title and time zone |

## What does not fit

EmDash blocks cannot contain other blocks, references or JSON. Nothing is dropped: a field with no equivalent is
kept as JSON (a `json` field in a collection, JSON in a `text` field inside a block) and listed in the report under
"Needs a decision". That covers plugin fields, Matrix fields nested too deeply for a repeater, entry references
inside blocks, and multi-file asset fields.

Read the report's decision count before judging how well a site fits EmDash.

## Things the report will tell you

- **Plugins.** Each installed plugin is listed with what happens to it. Plugin settings do not transfer; some plugin
  data does (per-entry SEO values are kept as JSON, Retour's exact redirects become redirects).
- **Redirects EmDash cannot hold.** Pattern redirects, redirects to another site and status codes other than 301,
  302, 307 and 308 are listed for you to recreate.
- **Sections the GraphQL schema cannot see.**
- **Required fields that content leaves empty.** Craft only enforces "required" on live entries. Where real content
  has a gap, the field is made optional in the seed so EmDash accepts it.
- **Duplicate slugs.** EmDash keys an entry by collection, slug and locale; a second entry with the same slug is
  imported under `<slug>-<id>`.
- **Fields Craft's GraphQL API cannot serve.** Some plugin fields fail there. The rest of the entry is still read.
- **Links between entries of the same collection.** EmDash resolves a link only to an entry created earlier, so apply
  the seed a second time with `--on-conflict update` to fill those in.

## Not covered

- Users, groups and permissions. EmDash does not import accounts, and Craft's password hashes would not work there.
- Templates. Twig to Astro is a rebuild.
- Form submissions, entry revisions and unpublished drafts of live entries.
- Nested lists in rich text are flattened by the HTML converter.
- Craft 4 and older project config. Upgrade to Craft 5 first.

## Develop

```bash
npm install
npm test          # seeds are checked with EmDash's own validateSeed(); queries run against a graphql-js stand-in for Craft
npm run typecheck
npm run dev -- schema test/fixtures/basic
```

Requires Node 22.18 or later. `test/fixtures/basic` is a synthetic Craft project; do not commit a real site's config.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) before opening a pull request, and [AGENTS.md](AGENTS.md) for the
code conventions. Vulnerabilities: [docs/SECURITY.md](docs/SECURITY.md).

## How this was built

The code, tests and documents in this repository were written with AI assistance (Claude Code, model Claude Fable 5.2),
directed and reviewed by the maintainer. That is the disclosure the project's own [AI usage policy](docs/AI_POLICY.md)
asks of every contributor.

## License

MIT
