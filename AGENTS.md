This file guides agentic coding tools working in this repository.

For setup, checks and the contribution policy, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). This file covers what an agent needs to write correct code here.

Follow [docs/AI_POLICY.md](docs/AI_POLICY.md) for anything outside the working tree. In particular: do not open issues or pull requests without the human authorising that specific one, do not comment on issues or discussions, and sign agent-written review comments as the policy requires.

# What this is

A CLI that converts a Craft CMS 5 project into an EmDash seed file. Two passes:

- **Schema** (`src/craft/load.ts`, `src/map/schema.ts`): reads `config/project/*.yaml` and writes collections, block types and taxonomies. It also produces the `Plan` that tells the content pass how to read each field.
- **Content** (`src/content/`): reads entries over Craft's GraphQL API, following the plan, and writes seed content.

Every run also writes a report. The report is the product as much as the seed: it is how a person learns what did not fit.

# Rules

**Never commit a real site.** No real project config, content, URLs, tokens or company names, in fixtures, tests, comments or docs. `test/fixtures/basic` is synthetic and stays that way. Run against a real site by pointing the CLI at its path and writing output outside the repository.

**Read-only towards Craft.** The tool runs GraphQL queries. It never sends a mutation and never writes to the Craft project.

**Nothing is dropped silently.** A field with no EmDash equivalent is kept as JSON and gets a `decide` note. A value that could not be read gets a note. If you add a mapping that loses information, add the note with it.

**The seed must be valid for EmDash.** Tests check the fixture's seed with EmDash's own `validateSeed()`. Before changing how something is mapped, read the [seed format](https://docs.emdashcms.com/themes/seed-files/) and [field types](https://docs.emdashcms.com/reference/field-types/); do not rely on memory of either.

**Notes are documentation.** A note says where, what happened, and what the person can do, in plain words. Someone who has never read this code should be able to act on it.

**Regression evidence for bugs.** A fix shows that it changes the reported behaviour. Add a regression test when it protects meaningful behaviour; otherwise report the reproduction and the check.

**Scope discipline.** No drive-by refactors, no bulk cleanups, no "while I'm here" edits in unrelated files. Report a systemic problem separately.

**Comments are for code readers, not reviewers.** See [Comments](#comments).

## Workflow

Before committing:

- `npm run typecheck`
- `npm test`
- `npm run build`

Treat a failing check as caused by the current work and fix it before committing. Do not dismiss it as pre-existing.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and say why, not only what.

When opening a pull request with `gh`, copy `.github/PULL_REQUEST_TEMPLATE.md` into the body and fill every section, including the AI disclosure. Tick only what you verified.

# Conventions

## TypeScript

Node runs `src/` directly by stripping types, so only erasable syntax is allowed: no enums, no namespaces, no constructor parameter properties. `tsc` enforces this (`erasableSyntaxOnly`).

- Internal imports use the `.ts` extension; the build rewrites them.
- Type-only imports use `import type`.
- `noUncheckedIndexedAccess` is on: an indexed read may be `undefined`.

## Craft specifics worth knowing

- Project config packs ordered maps as `{ __assoc__: [[key, value], …] }`. `unpackAssoc` undoes that; read settings through the loader, not the raw YAML.
- A field layout can rename a field for one entry type (`handle` on the layout element). Use the layout's handle, not the field's.
- GraphQL type names are `<entryTypeHandle>_Entry`. Two entry types may give one handle to fields of different types, so the content pass aliases every field by its entry type.
- Craft's project config and its GraphQL schema can disagree about which entry types a Matrix field holds. The content pass trusts the GraphQL schema for what it can query.
- Craft enforces "required" only when an entry is saved live. Real content has gaps.
- An entry type can nest itself through a Matrix field. Anything that walks entry types needs a bound or a visited set.
- EmDash blocks cannot nest. A nested Matrix becomes a repeater when its rows are simple and is otherwise flattened into sibling blocks that follow their parent; see the README.

## Comments

Comments are evergreen and addressed to a future reader of the code. Most comments an agent writes should not exist. A comment earns its place only when:

- the code is unclear and cannot be made clearer (try that first), or
- there is a non-obvious reason the reader would otherwise get wrong: an ordering constraint, a quirk of Craft or EmDash, an invariant.

Comments are not summaries of the change, messages to a reviewer, justification for a decision, or a record of what was tried. Never reference issues, pull requests or review threads in a comment; that belongs in the commit message.

# Testing

Vitest. `test/schema.test.ts` covers the schema pass on the fixture. `test/content.test.ts` runs the content pass against a stand-in for Craft's GraphQL API built with `graphql-js`, shaped like the schema Craft generates for the fixture, so generated queries are validated by a real GraphQL implementation.

When Craft does something the stand-in does not model, extend the stand-in to match Craft; do not weaken the query builder to suit the stand-in.

**A test must be able to fail on a real regression.** If it cannot, delete it. Common offenders:

- asserting a constant or config literal back at itself;
- asserting the implementation detail you just wrote instead of what it does for the user;
- a mock that returns the very value the assertion checks;
- tests that only exercise a dependency.

**Never change a test just to make it pass.** Work out why it fails first; the test may be the only thing that is right. If you cannot, stop and say so.

---

Adapted from [EmDash's AGENTS.md](https://github.com/emdash-cms/emdash/blob/main/AGENTS.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
