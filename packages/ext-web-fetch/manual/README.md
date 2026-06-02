---
description: Web page fetching with Playwright rendering, cleaning pipelines, and domain policy
---

# web-fetch

Fetches web pages via a Playwright subprocess, renders JavaScript, and processes content through cleaning pipelines. Writes results to staging files the agent reads.

## USAGE

Single tool: `web__fetch`. Takes a URL, fetches and renders the page, runs cleaning pipelines, writes output files to `/staging/in/`.

**Typical flow:** agent uses WebSearch to find URLs, then `web__fetch` to read specific pages. The tool returns metadata and file paths — the agent reads content via the Read tool.

**Pipelines:** `crawl4ai` (default, token-efficient markdown), `markdown` (full markdown), `raw` (original HTML). Agent can request multiple. Binary content (PDFs, images) is written as-is.

**Staging files are ephemeral** — cleared when the conversation ends. Agent should copy to `/memory/` if needed long-term.

## CONFIG

| Field | Type | Default | Lockable | Effect |
|-------|------|---------|----------|--------|
| `fetch_mode` | `disabled \| approval \| open` | `approval` | yes | Approval policy. See table below. |
| `allowed_domains` | `string[]` | `[]` | yes | Approval bypass list. Only consulted under `approval` mode. Supports wildcards: `*.example.com`. |
| `blocked_domains` | `string[]` | `[]` | yes | Always-rejected domains. Checked in every mode. Same wildcard syntax. |
| `allow_query_strings` | `boolean` | `true` | yes | Whether query strings are preserved. `false` strips `?...` and `#...`. |

Mode semantics:

| Mode | `blocked_domains` | `allowed_domains` | Everything else |
|------|-------------------|-------------------|-----------------|
| `disabled` | — | — | Tool not registered — agent cannot fetch. |
| `approval` | reject | fetch, no prompt | **prompt user for approval** |
| `open` | reject | (irrelevant) | fetch, no prompt |

SSRF protection is always enforced regardless of mode — loopback, link-local, and private IP ranges are blocked.

**Built-in `WebFetch` is disabled under `sdk-only` (the default network mode).** The host adds Claude's built-in `WebFetch` to the agent's `disallowedTools`, removing it from the model's context — so it isn't reachable via `ToolSearch`, and all fetching goes through `mcp__cast__web__fetch`, where this extension's policy (domain allowlist, approval) applies. On a `full`-network agent the built-in stays available, but there the domain policy is moot regardless — the agent can already reach any host directly (Bash, any MCP tool) — so this extension only meaningfully constrains fetching under `sdk-only`. **Run policy-bearing agents on `sdk-only`.**

## SECRETS

None. No credentials required.

## STORAGE

No persistent storage. All output goes to per-conversation staging (`/staging/in/`).

## SECURITY

### Input surface

The agent can fetch and read any web page within the domain policy. Page content may include anything on the public web.

### Output surface

None — this extension only reads, never writes externally. The fetch request itself is an information disclosure vector (the target server sees the request).

### Config risk levels

| Setting | Safe | Unsafe | Dangerous |
|---------|------|--------|-----------|
| `fetch_mode` | `approval` (default) or `disabled` | `open` with blocked list | `open` with empty `blocked_domains` — agent browses any site without prompt |
| `allowed_domains` | Empty or narrow list (under `approval`) | Broad list of trusted domains | Very broad wildcards like `*.com` |
| `blocked_domains` | Block known-risky domains | Empty — no blocks beyond SSRF | N/A |

## ADMIN

No secrets. Config only.

| Field | Input type | Help text |
|-------|-----------|-----------|
| `fetch_mode` | select (`open` / `approval` / `disabled`) | Open: any domain fetches without prompting. Approval: listed domains skip, others require human approval. Disabled: no fetching. |
| `allowed_domains` | editable list of strings | Domains that fetch without prompting. Only consulted in Approval mode. Wildcards: `*.example.com` matches `foo.example.com`. |
| `blocked_domains` | editable list of strings | Always-rejected domains. Checked in every mode. |
| `allow_query_strings` | toggle | Whether URLs keep their query strings. Off = strips `?...` and `#...` from fetched URLs. |

No validation needed beyond type checking.

## SERVICE API

| Method | Signature | Description |
|--------|-----------|-------------|
| `fetch` | `(req: FetchRequest) => Promise<FetchResult>` | Fetch a URL. SSRF protection applied, domain policy skipped. |

Request/result types exported from `@getcast/agent-schema/v1`.
