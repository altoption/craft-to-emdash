# Contributing to craft-to-emdash

Thanks for helping. This is a small tool with one maintainer, so the process is short. The rules that exist are there to keep reviews possible.

- [AI usage policy](AI_POLICY.md): what agents may and may not do here.
- [Triage guide](TRIAGE.md): how issues and pull requests are sorted.
- [Maintainer guide](MAINTAINING.md): what a change needs before it merges.
- [Security policy](SECURITY.md): how to report a vulnerability privately.
- [AGENTS.md](../AGENTS.md): code conventions, for people as much as for agents.

## Prerequisites

Node 22.18 or later, and npm.

## Setup

```bash
npm install
npm test
npm run dev -- schema test/fixtures/basic
```

`npm run dev` runs the CLI from source. To try it on a real Craft project, point it at that project and write the output somewhere outside this repository:

```bash
npm run dev -- content ~/sites/my-craft-site --craft "ddev craft" --out /tmp/my-site
```

## Layout

```
src/craft/     reads Craft's project config
src/map/       maps the content model to an EmDash seed and plans the content pass
src/content/   reads entries over GraphQL and converts them
src/seed/      the parts of the seed format this tool writes
test/fixtures/ a synthetic Craft project
```

## Checks

Run all three before pushing:

```bash
npm run typecheck
npm test
npm run build
```

## Contribution policy

### Choose a path

| Type | Process |
| --- | --- |
| **Bug fix** | Open a pull request. Include a regression test when it protects meaningful behaviour; otherwise include the reproduction and how you verified the fix. |
| **A Craft field type or plugin field that maps badly** | Open an issue first with the field's project-config YAML and what its GraphQL type looks like (both with site details removed). Mapping changes affect every user's output. |
| **Documentation or tests** | Open a pull request. |
| **Chore** | Open a pull request when it is concrete and scoped. |
| **Refactor with no behaviour change** | Open a pull request and show the output is unchanged. |
| **Feature** | Open an issue describing the problem and the proposed behaviour, and wait for the maintainer to agree before writing the code. |

### What is not accepted

- **Drive-by changes.** See [pull request eligibility](AI_POLICY.md#pull-request-eligibility).
- **Speculative refactors** that solve no concrete problem.
- **Unrelated "improvements"** bundled into a change.
- **Bulk pull requests** ("fix all lint warnings", "add types everywhere").
- **Real site data.** No real project config, content, URLs or tokens in fixtures, tests, issues or pull requests. Reduce a problem to a synthetic example.

### AI-assisted contributions

Welcome. You remain responsible for the change: read all of it, test it, and disclose the models or tools used. Read the [AI usage policy](AI_POLICY.md) before using an agent to open an issue or pull request.

### Reporting a conversion problem

The most useful report has:

- the Craft and plugin versions;
- the command you ran, with any token removed;
- the relevant lines of `report.md`;
- the smallest project-config YAML that reproduces it, with names changed.

Say what you expected in EmDash and what you got.

### Pull request rules

- Branch from `main`.
- Fill out the pull request template completely.
- The three checks pass.
- A change to how something is mapped updates the table in the README and the tests.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and describe why, not just what.

## Getting help

Open a discussion or an issue. Please do not email the maintainer about bugs; a public thread helps the next person.

---

Adapted from [EmDash's CONTRIBUTING.md](https://github.com/emdash-cms/emdash/blob/main/CONTRIBUTING.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
