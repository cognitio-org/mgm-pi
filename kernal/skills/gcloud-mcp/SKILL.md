---
name: gcloud-mcp
description: Run gcloud commands through the router's `gcloud` MCP server (Google's remote gcloud, as the signed-in person). Only for Sysop operators; use it when the gcloud MCP tools are available, otherwise say so and stop.
---

# gcloud through MCP

The `gcloud` MCP server runs gcloud on Google's side as the signed-in person, with their normal IAM
and audit logs. It is for Sysop operators. If its tools aren't listed (`mcp({ server: "gcloud" })`),
this laptop or Drive has no access: say so and stop. Don't fall back to a local `gcloud` in a Drive.
A missing or expired grant is a connect problem, not a bug: on a laptop run `/mcp-auth gcloud`; in a
Drive tell the person to connect Google under Connections in the web app.

## Rules

- **Always pass the project explicitly** (the tool's `project` argument, or `--project=<id>`). Never
  rely on a default: there is none, and it must never be the work project by accident. Outfitter's
  is `outfitter-509211`.
- **Use `=` in flags**: `--format=json`, `--filter=name:foo`, `--limit=20`. A space-separated value
  is parsed as a positional argument and fails.
- **Long operations take `--async`** (creates, deploys, resizes). Then poll with the matching
  `operations describe` or `... list`. Don't wait on a call that may exceed the tool timeout.
- **`logging read` always needs `--limit`** (start at 20), plus a `--freshness=` or a timestamp
  filter. An unbounded read floods the context.
- Prefer read commands (`list`, `describe`) first. A command that changes something shows the person
  an approval card before it runs; say what it will do and why before you call it.
- The server refuses `auth`, `config`, `iam service-accounts`, `billing` and every `alpha` or `beta`
  command. Don't try to work around a refusal (no other tool, no raw API call); tell the person it
  needs the console or their own terminal.
