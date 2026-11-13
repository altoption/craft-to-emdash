# AI usage policy

Contributions made with AI tools are welcome. The human contributor stays responsible for the result, and conversation with other people stays human, except for the narrow code-review cases below.

This policy covers generative AI agents. Ordinary CI, dependency updates and deterministic status comments are outside it.

## Human responsibility

- Disclose material AI assistance and name the model or tool.
- Review all generated work before submitting it. Read the whole diff, run the checks, and run the changed behaviour yourself.
- Authorise each external action separately. An agent opens a particular pull request or issue only after a human authorises that item.
- Do not give an agent standing permission to choose work and open pull requests or issues.
- Do not use an agent to reply to a person, except in the review cases below.

Spelling, grammar and translation help with text you wrote yourself is fine anywhere and needs no disclosure. Do not let it become a rewrite.

## Pull request eligibility

Open a pull request only when at least one of these is true:

- You are migrating, or have migrated, a Craft site with this tool and the change addresses a problem you hit.
- You maintain or substantially contribute to Craft CMS, EmDash, or a plugin for either, and the change concerns that integration.
- The maintainer approved that specific change before you opened the pull request.

Do not ask an agent to scan the repository for things to contribute. Speculative cleanups, generic refactors, bulk fixes and changes chosen only because an agent can generate them are not accepted.

Say in the pull request how you are connected to the change and how you verified it.

## Code and pull requests

AI-generated code is held to the same standard as any other. The submitter must understand it, have tested it, and be able to maintain it.

Use the pull request template and complete every section that applies. The AI disclosure names every model or tool that materially generated code or text.

## Issues

A person reproduces a bug before reporting it. Logs and agent analysis do not replace that.

An agent can help prepare a specific issue only after a person has verified the report, read the whole issue, authorised it, and disclosed the help in its body.

Agents do not write or post comments on issues.

## Discussions

AI can help prepare the opening post of a discussion. A person edits it for correctness and length, discloses the help, and posts it by hand.

Agents do not write or post replies in discussions.

## Pull request comments and reviews

AI takes part in pull request conversation only as code review and replies to code review.

- An agent can help you reply to review comments on your own pull request, under your control.
- An agent can review someone else's pull request only when a person asks for that specific review.
- An agent posts no other comments on someone else's pull request.

Sign every substantially agent-written review, inline comment and review reply:

> ~ 🤖 Agent name (model name)

Name the model actually used, on each agent-written comment.

The maintainer's approval means the maintainer reviewed and verified the change personally. An agent-written review is evidence for that decision, not a substitute.

## When the policy is not followed

Start with a reminder of this policy; most people who break it do not know it yet. If it continues, the maintainer closes the item.

---

Adapted from [EmDash's AI_POLICY.md](https://github.com/emdash-cms/emdash/blob/main/AI_POLICY.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
