# craft-to-emdash

Convert a [Craft CMS](https://craftcms.com) 5 project into an [EmDash](https://github.com/emdash-cms/emdash) seed file.

Status: early. The schema pass works; the content pass is not written yet.

## Use

```bash
npx craft-to-emdash schema path/to/craft-project --out out
```

It reads `config/project/` and writes:

- `out/seed.json`: an EmDash seed (format `1`) holding the content model.
- `out/report.md`: what was converted, and every place a person has to decide something.

Then, in an EmDash project:

```bash
npx emdash seed out/seed.json --validate
npx emdash seed out/seed.json --no-content
```

The tool needs no access to the running Craft site for this pass.

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
| Categories | Taxonomy on the collection |

## What does not fit

EmDash blocks cannot contain other blocks, references or JSON. Nothing is dropped: a field with no equivalent is
kept as JSON (a `json` field in a collection, JSON in a `text` field inside a block) and listed in the report under
"Needs a decision". That covers plugin fields, Matrix fields nested too deeply for a repeater, entry references
inside blocks, and multi-file asset fields.

Read the report's decision count before judging how well a site fits EmDash.

## Not covered

Templates (Twig to Astro is a rebuild), users, form submissions, and entry revisions. Craft 4 and older project
config is not read; upgrade to Craft 5 first.

## Develop

```bash
npm install
npm test          # the fixture's seed is checked with EmDash's own validateSeed()
npm run typecheck
npm run dev -- schema test/fixtures/basic
```

Requires Node 22.18 or later. `test/fixtures/basic` is a synthetic Craft project; do not commit a real site's config.

## License

MIT
