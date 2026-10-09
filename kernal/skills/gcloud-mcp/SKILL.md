---
name: gcloud-mcp
description: Operate Google Cloud through the router's `google_cloud` toolset (Cloud Run, Logging, Monitoring and Firestore product tools, plus run_gcloud_command), as the signed-in person. Only for Sysop operators; use it when those tools are available, otherwise say so and stop.
---

# Google Cloud through MCP

The `google_cloud` MCP entry is one router toolset with one Google sign-in. It runs on Google's side
as the signed-in person, with their normal IAM and audit logs. It is for Sysop operators. If its tools
aren't listed (`mcp({ server: "google_cloud" })`), this laptop or Drive has no access: say so and stop.
Don't fall back to a local `gcloud` in a Drive. A missing or expired grant is a connect problem, not a
bug: on a laptop run `/mcp-auth google_cloud` (once covers every tool below); in a Drive tell the
person to connect Google under Connections in the web app.

If only the older `gcloud` entry is listed (`mcp({ server: "gcloud" })`; the toolset isn't delivered to
this key yet), use `run_gcloud_command` there and say that the product tools need `kernal login` after
the operator's key is re-minted with the toolset.

## Product tools first, the CLI for the rest

Tool names are prefixed with their server: `cloudrun-<tool>`, `cloudlogging-<tool>`,
`cloudmonitoring-<tool>`, `firestore-<tool>`, and `gcloud-run_gcloud_command` for the CLI.

- **Prefer a product tool** for Cloud Run (services, revisions, deploys), Cloud Logging (reads),
  Cloud Monitoring (metrics, PromQL `query_range`) and Firestore (document reads and writes). They are
  typed and mark read-only tools, and do things gcloud can't (Firestore documents, PromQL ranges).
- **Use `run_gcloud_command`** for everything without a product server: Domains, DNS, Secret Manager,
  Cloud Build, Artifact Registry, IAM reads and the rest. The rules below apply to it.
- **Approvals:** read-only tools run; anything that changes something (a deploy, a write, a delete)
  shows the person an approval card first. Say what it will do and why before you call it.

## Calling `gcloud-run_gcloud_command` (verified live)

It takes two required arguments, and both matter:

```json
{
  "project": "projects/outfitter-509211",
  "command": "gcloud run services list --project=outfitter-509211 --region=us-central1 --format=json --limit=20"
}
```

- **`command` must start with `gcloud`** (or `bq` for `run_bq_command`); `run services list` alone
  is rejected.
- **`project` (`projects/<id>`) only picks the project for Google's quota and API enablement.** It
  does not set the command's project: **also put `--project=<id>` in the command**, or gcloud fails
  with "the [project] resource is not properly specified".
- **There is no default project and no wildcard.** `projects/-` returns 403, and `gcloud config ...`
  is refused, so you can't read one. If the person didn't name a project, ask, or list them with
  `project: "projects/outfitter-509211"` and `command: "gcloud projects list --project=outfitter-509211 --format=value(projectId)"`.

Product tools take their own typed parameters; read the tool's schema rather than guessing. For
example `cloudrun-list_services` is `{"project": "outfitter-509211", "region": "us-central1"}`
(a bare project id, not `projects/...`).

## Rules

- **Always pass the project explicitly** (both forms above for the CLI; the tool's own parameter for
  product tools). Never rely on a default: there is none, and it must never be the work project by
  accident. Outfitter's is `outfitter-509211`.
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
