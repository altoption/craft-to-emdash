# Security policy

craft-to-emdash reads a Craft CMS site, including unpublished content, and writes a file another system will import. Please report suspected vulnerabilities privately so a fix can be prepared before disclosure.

## Supported versions

Reports should target the `main` branch or the latest published version.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include enough detail to reproduce and assess the issue.

Do not open a public issue with exploitable details. A public issue may ask for routing or status only.

## What to include

- the version or commit;
- the command and options used, with tokens removed;
- reproduction steps or a minimal proof of concept, using synthetic data;
- the impact, and what access an attacker needs;
- whether it involves the GraphQL endpoint transport, the console transport, or the generated seed.

## Scope

High-signal reports include:

- the tool sending a mutation or otherwise changing a Craft site;
- a GraphQL token leaking into output files, logs, checkpoints or error messages;
- content from Craft causing code or commands to run on the machine running the tool, including through the console transport;
- a crafted Craft project or GraphQL response writing files outside the output directory;
- generated seed content that makes EmDash fetch internal addresses or run script when imported, beyond what the Craft content itself contained.

Usually out of scope:

- scanner output without a working reproduction;
- issues that need a compromised machine or a malicious Craft administrator who could already do the same harm directly;
- the seed containing unpublished content: reading it is the tool's purpose. Treat `seed.json` and `.checkpoints/` like a database backup;
- dependency age without exploitability.

## Coordinated disclosure

The maintainer acknowledges valid-looking reports as soon as practical and keeps the reporter informed while a fix is prepared. Please allow a reasonable time to investigate and release before disclosing.

## Safe harbour

Good-faith research is welcome within this repository and your own Craft and EmDash installations. Do not access, change or exfiltrate other people's data.

---

Adapted from [EmDash's SECURITY.md](https://github.com/emdash-cms/emdash/blob/main/SECURITY.md) (MIT, Copyright 2026 Cloudflare Inc.), fitted to a small project with one maintainer and no bots.
