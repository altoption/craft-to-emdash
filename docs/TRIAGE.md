# Triage guide

How issues, discussions and pull requests are sorted here. There are no bots: every label and reply comes from a person.

Anyone can help triage. There is no quota or schedule; do what you enjoy, and step back whenever you like. Labels can be changed and issues reopened, so mistakes are cheap.

## Tone

Assume good intent. Many people using a migration tool are not Craft or EmDash experts, and for some this is their first issue anywhere. One short, specific question beats a checklist.

Good:

```markdown
Thanks for the report. Could you paste the lines for that field from `report.md`, and the field's YAML from `config/project/fields/` with any names changed?
```

Avoid:

```markdown
Cannot reproduce. Please provide a real reproduction.
```

Prefer:

```markdown
I can't reproduce this from the description yet. Could you share the smallest project config that shows it, or the command you ran?
```

## Issue triage

Start by working out what kind of issue it is.

| If it is… | Do this |
| --- | --- |
| A conversion bug | Ask for the missing details, try to reproduce it on a synthetic fixture, add a priority if the impact is clear. |
| A field type or plugin that maps badly | Label `mapping`. Ask for the field's YAML and its GraphQL type. |
| A feature request | Label `feature`. Ask what problem it solves if that is not stated. |
| A question | Answer if you can, then close. |
| A duplicate | Link the earlier issue and close. |
| Not enough to go on | Label `needs-info` and ask one or two specific questions. |
| Real site data posted by mistake | Tell the reporter and the maintainer at once so it can be removed. Tokens must be rotated, not just deleted. |

Useful details to ask for, only as needed:

- Craft version, and the versions of plugins involved;
- EmDash version, if the problem shows when applying the seed;
- which transport: `--craft` or `--endpoint`;
- the relevant lines of `report.md`;
- the error from `emdash seed`, if any.

Ask for the smallest missing piece that would unblock the next person, not for everything.

### Priority

Priority is a judgment a person adds when the impact is clear.

- `priority/urgent`: content lost or changed without a note, anything that writes to Craft, a leaked token, a seed EmDash accepts but imports wrongly.
- `priority/high`: a common Craft setup fails to convert or to apply.
- `priority/normal`: valid, not urgent.
- `priority/low`: polish and rare cases.

If you are unsure, leave it unset and say what would help judge it. A confirmed reproduction, with the fixture you used, is the best evidence.

## Pull request triage

First: is this something the project accepts? The full policy is in [CONTRIBUTING.md](CONTRIBUTING.md#contribution-policy).

Accepted directly: bug fixes with evidence, documentation, tests, scoped chores, refactors that leave output unchanged.

Needs an agreed issue first: features, and changes to how a field type is mapped.

Normally closed: features with no agreed issue, and drive-by changes that do not meet the [eligibility rules](AI_POLICY.md#pull-request-eligibility).

If a feature arrives with no issue:

```markdown
Thanks for the PR. Features start with an issue so the behaviour is agreed before the code is reviewed. Could you open one describing the problem and what you propose? The code can stay on your branch meanwhile.
```

### What to look for

- Is the template filled out, including the AI disclosure?
- Does it say why the change is needed, and does the reason hold up?
- For a bug fix, is there a test that would fail without it?
- Does it include any real site's config, content or URLs? That blocks the PR until removed from its history.
- Does the fixture's seed still pass EmDash's validator?
- If output changed, did the README table change with it?
- Most important: does it work? Running the branch against a Craft project catches what reading a diff will not.

Any one of these checks is a useful contribution.

### AI-assisted contributions

The job is not to detect AI. It is to check that a person understands the change. "What did you test, and how?" is a fair question on any PR. An author who cannot answer questions about their own PR, or answers only with pasted agent output, has not met the bar yet; ask them to test and confirm in their own words.

## Boundaries

Triage moves a conversation forward; it does not own the outcome. It is fine to stop once an issue is clearer, a reproduction is confirmed, or the decision the maintainer needs to make is named. If a thread gets tense, step back and leave it to the maintainer.

If you reproduce a bug and can see the fix, opening the pull request yourself is the best outcome.

---

Adapted from [EmDash's TRIAGE.md](https://github.com/emdash-cms/emdash/blob/main/TRIAGE.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
