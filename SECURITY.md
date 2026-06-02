# Security Policy

Cast is a security-positioned framework. The core guarantee is **container-level isolation** between agents and the host: an agent can read what's explicitly mounted, write to its memory and home directories, and nothing else. It cannot rewrite its own identity, see its own config, access other agents, or reach the server filesystem.

## Threat model

Cast guards against two adversaries:

1. **Malicious LLMs** — an agent's runtime producing arbitrary or malicious tool calls
2. **Malicious strangers** — external participants reaching agents via Telegram, email, web, or other transports

Cast does **not** defend against:

- Malicious operators (anyone with shell access to the Cast host)
- Malicious extension code (extensions run unsandboxed on the host)
- Compromised host (kernel exploits, privileged container escape, etc.)

This is the explicit, narrow scope. The container is an LLM sandbox, not a host firewall.

## Reporting a vulnerability

Use [GitHub Security Advisories](https://github.com/yaodub/cast/security/advisories/new) to file a private report.

We acknowledge within 72 hours and aim to publish a fix or coordinate disclosure within 90 days. If the vulnerability is already public, please mention this in your report so we can prioritize accordingly.

## Scope

### In scope

- Container escape (an agent breaking out of its container)
- ACL bypass (an unauthorized identity reaching an agent or channel)
- Identity spoofing at the transport or bus layer
- Server-side vulnerabilities (admin UI, gateway, message bus)
- Cross-agent data leakage (one agent reading another's data)
- Prompt injection that crosses the trust boundary

### Out of scope

- Vulnerabilities in third-party extensions (report to their maintainers)
- Operator-controlled paths (the threat model assumes a trusted operator)
- Issues requiring shell access to the Cast host
- Denial of service via legitimate Cast features (sending many messages, scheduling many tasks)
- Social engineering of operators or users
- Vulnerabilities in user-authored agent blueprints

If you're not sure whether something is in scope, report it anyway and we'll triage.
