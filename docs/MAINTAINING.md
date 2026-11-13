# Maintaining craft-to-emdash

This guide sets out what a change needs before it merges. The project has one maintainer today; the rules are written so they still hold when there are more.

## Merge requirements

A pull request can merge when:

- the checks pass (`typecheck`, `test`, `build`);
- review threads are resolved;
- the maintainer has reviewed the current revision personally; and
- a feature or mapping change follows what was agreed in its issue.

With one maintainer, the maintainer's own changes cannot be approved by someone else. For those, the maintainer reads the full diff as a reviewer would, after the checks pass, and does not merge on the strength of an agent's review alone. Once a second maintainer joins, a change needs approval from a maintainer other than its author, and routine self-merge stops.

An approval applies to the revision that was reviewed. A later substantive commit needs another look.

Automated reviews, test results and static analysis help the reviewer. They do not replace the review. An agent-written review, including one posted from the maintainer's own account, is evidence for the decision, not the decision.

## Changes that need extra care

- contribution policy, and these documents;
- release and package-publishing automation;
- anything that handles a GraphQL token or decides what is sent to a Craft site;
- the console transport, which runs code inside a Craft installation;
- any other path where a compromise could alter or publish a release.

The maintainer makes or reviews these line by line. With two maintainers, they need both.

## Review responsibilities

Before approving, check what applies:

- the contribution is in scope and took the right path;
- the tool is still read-only towards Craft;
- nothing is dropped silently: what does not map is kept and reported;
- the output is still a seed EmDash accepts;
- tests exercise behaviour a user would notice, and the reported bug when there is one;
- no real site data came in with the change;
- a change in output is described in the README and the changelog.

## Releases

Before publishing to npm: run the checks on a clean checkout, convert the fixture, and apply its seed to a fresh EmDash database (`npx emdash seed out/seed.json --database /tmp/check.db --skip-media`). A seed that validates can still fail to apply.

## Decisions

Explain a public decision in the issue or pull request it concerns. Keep security reports and anything involving credentials or private site data out of public threads.

---

Adapted from [EmDash's MAINTAINING.md](https://github.com/emdash-cms/emdash/blob/main/MAINTAINING.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
