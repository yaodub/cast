/**
 * Web-fetch standard extension.
 *
 * Manages the @getcast/web-fetch HTTP service subprocess (Playwright + caching)
 * and provides the web__fetch MCP tool. Per-agent domain policy is applied
 * in the MCP tool handler; the public fetch() client method applies only
 * SSRF protection (security boundary).
 *
 * Subprocess lifecycle:
 *   onServerStart(log) → spawn with PORT=0, child reports actual port via IPC
 *   onServerStop(log)  → kill child process
 */
import { createHash } from 'crypto';
import { fork, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { z } from 'zod';

import {
  WebFetchPolicySchema,
  FetchRequestSchema,
  FetchResultSchema,
  type WebFetchPolicy,
  type FetchRequest,
  type FetchResult,
} from './schemas.js';

import {
  defineExtension,
  noopLogger,
  textResult,
  type ExtensionContext,
  type ExtensionInstance,
  type Logger,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
} from '@getcast/extension-schema';

// ---------------------------------------------------------------------------
// Module-level subprocess state
// ---------------------------------------------------------------------------

// SIDE EFFECT: Module-level subprocess state shared across all agent instances.
// Required because the web-fetch subprocess pool is a server-level resource, not per-agent.
// serverLog captured from onServerStart() for async event handlers (child exit/error).
let serviceProcess: ChildProcess | null = null;
let baseUrl: string | null = null;
let serverLog: Logger = noopLogger;

// ---------------------------------------------------------------------------
// Domain policy (SSRF protection)
// ---------------------------------------------------------------------------

/** Reject loopback, link-local, and private IP ranges. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h))
    return true;
  if (/^(::1|fe80:|fc00:|fd[0-9a-f]{2}:)/i.test(h)) return true;
  return false;
}

function matchDomain(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === pattern;
}

// ---------------------------------------------------------------------------
// HTTP client (calls web-fetch subprocess)
// ---------------------------------------------------------------------------

function httpPost(url: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// File writing (staging/in)
// ---------------------------------------------------------------------------

function writeResultFiles(
  stagingDir: string,
  url: string,
  fetchResult: FetchResult,
): Record<string, { path: string; tokens: number }> {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  fs.mkdirSync(stagingDir, { recursive: true });

  const written: Record<string, { path: string; tokens: number }> = {};
  const isBinary = fetchResult.encoding === 'base64';

  for (const [key, content] of Object.entries(fetchResult.files)) {
    const ext = isBinary
      ? (fetchResult.ext ?? 'bin')
      : key === 'raw'
        ? 'html'
        : 'md';
    const filename = `fetch_${hash}.${key}.${ext}`;
    if (isBinary) {
      fs.writeFileSync(
        path.join(stagingDir, filename),
        Buffer.from(content, 'base64'),
      );
    } else {
      fs.writeFileSync(path.join(stagingDir, filename), content);
    }
    const tokens = fetchResult.meta.sizes[key]?.tokens ?? 0;
    written[key] = { path: `/staging/in/${filename}`, tokens };
  }

  const metaFilename = `fetch_${hash}.meta.json`;
  fs.writeFileSync(
    path.join(stagingDir, metaFilename),
    JSON.stringify(fetchResult.meta, null, 2),
  );
  written['meta'] = { path: `/staging/in/${metaFilename}`, tokens: 0 };

  return written;
}

// ---------------------------------------------------------------------------
// Subprocess management
// ---------------------------------------------------------------------------

/** Shape of IPC messages the web-fetch subprocess sends to the host. */
const IpcMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), port: z.number() }),
]);

function resolveServerEntry(): string {
  // Prod (bundled): this file runs from dist/ with the self-contained
  // web-fetch-server.js bundle beside it — a plain-node-forkable .js. Prefer it.
  // import.meta.resolve must NOT win here: in a pnpm workspace it *succeeds*
  // with @getcast/web-fetch's `./server` export, which points at .ts source the
  // forked plain-node child can't execute — silently breaking the service.
  const bundled = path.join(import.meta.dirname, 'web-fetch-server.js');
  if (fs.existsSync(bundled)) return bundled;
  // Dev: no bundle beside the source entry. Resolve the workspace package and
  // let the forked child inherit the parent's TS loader (tsx). A throw here is a
  // genuine misconfiguration — surface it rather than masking it.
  const resolved = import.meta.resolve('@getcast/web-fetch/server');
  return resolved.startsWith('file://') ? new URL(resolved).pathname : resolved;
}

function spawnService(log: Logger): Promise<string> {
  const entryPath = resolveServerEntry();
  log.info({ entryPath }, 'Spawning web-fetch service');

  return new Promise<string>((resolve, reject) => {
    const child = fork(entryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PORT: '0' },
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('web-fetch service startup timed out (10s)'));
    }, 10_000);

    child.on('message', (msg: unknown) => {
      const parsed = IpcMessageSchema.safeParse(msg);
      if (!parsed.success) {
        log.warn({ issues: parsed.error.issues }, 'Unknown IPC message from web-fetch service');
        return;
      }
      const m = parsed.data;
      if (m.type === 'ready') {
        clearTimeout(timeout);
        serviceProcess = child;
        baseUrl = `http://127.0.0.1:${m.port}`;
        log.info({ port: m.port }, 'web-fetch service ready');
        resolve(baseUrl);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (!baseUrl) {
        reject(
          new Error(
            `web-fetch service exited with code ${code} before ready`,
          ),
        );
      } else {
        serverLog.warn({ code }, 'web-fetch service exited unexpectedly');
        serviceProcess = null;
        baseUrl = null;
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      serverLog.warn({ service: 'web-fetch' }, data.toString().trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Extension class (per-agent instance)
// ---------------------------------------------------------------------------

class WebFetchExtension implements ExtensionInstance {
  readonly name = 'web-fetch';
  private policy: WebFetchPolicy;
  private log: Logger;

  constructor(ctx: ExtensionContext<WebFetchPolicy, Record<string, never>>) {
    this.policy = ctx.config;
    this.log = ctx.log ?? noopLogger;
  }

  get tools(): ToolDefinition[] {
    if (!baseUrl || this.policy.fetch_mode === 'disabled') return [];

    const isApproval = this.policy.fetch_mode === 'approval';
    const { allowed_domains, blocked_domains } = this.policy;
    const domainNote = isApproval
      ? allowed_domains.length > 0
        ? `Trusted domains (no approval needed): ${allowed_domains.join(', ')}. Other domains require human approval.`
        : 'All fetches require human approval.'
      : blocked_domains.length > 0
        ? `Open internet access (blocked: ${blocked_domains.join(', ')}).`
        : 'Open internet access.';

    return [
      {
        name: 'web__fetch',
        description: `Fetch a web page, process it through cleaning pipelines, and write output files. Returns metadata and file paths — use the Read tool to access content.

Default pipeline: crawl4ai (token-efficient markdown). Add "raw" for original HTML.
Use WebSearch to discover URLs, then web__fetch to read specific pages.

${domainNote}`,
        schema: {
          url: z.string().url().describe('URL to fetch (http/https only)'),
          pipelines: z
            .array(z.string())
            .optional()
            .describe(
              'Pipelines to run (default: ["crawl4ai"]). Options: "crawl4ai", "markdown", "raw".',
            ),
        },
        approval: isApproval ? {
          enabled: true,
          preview: (args) => ({ summary: `Fetch ${(args as { url: string }).url}` }),
          filter: (args, _ctx) => {
            let url: URL;
            try { url = new URL((args as { url: string }).url); } catch { return 'block'; }
            if (isPrivateHost(url.hostname)) return 'block';
            if (this.policy.blocked_domains.some((p) => matchDomain(url.hostname, p))) return 'block';
            if (this.policy.allowed_domains.some((p) => matchDomain(url.hostname, p))) return 'skip';
            return 'approve';
          },
        } : undefined,
      },
    ];
  }

  get promptSection(): string {
    return [
      '## Web Content',
      '',
      'Use the `mcp__cast__web__fetch` tool for ALL web page fetching. Do not use the built-in `WebFetch` tool — it bypasses this agent\'s fetch policy (domain allowlist, approval gates).',
      '- Renders the page, cleans the HTML, writes processed files to `/staging/in/`.',
      '- Returns metadata and file paths — use `Read` to access content.',
      '- Default pipeline: `crawl4ai` (token-efficient markdown). Add `raw` for original HTML.',
      '- Use `WebSearch` to discover URLs, then `mcp__cast__web__fetch` to read specific pages.',
      '- Fetched files are ephemeral (cleared when conversation ends). Copy to `/memory/` if needed long-term.',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // MCP tool handler (policy enforcement + staging writes)
  // ---------------------------------------------------------------------------

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    call: ToolCallContext,
  ): Promise<ToolResult> {
    // Lazy respawn if the subprocess died since startup
    if (!baseUrl && !serviceProcess) {
      try {
        this.log.info('web-fetch service not running, attempting respawn');
        await spawnService(serverLog);
      } catch (err) {
        this.log.warn({ err }, 'web-fetch respawn failed');
      }
    }
    if (!baseUrl) {
      return textResult('Web-fetch service is not running.', true);
    }

    const parsed = FetchRequestSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        true,
      );
    }

    // Parse URL
    let url: URL;
    try {
      url = new URL(parsed.data.url);
    } catch {
      return textResult(`Invalid URL: ${parsed.data.url}`, true);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return textResult(`Only http/https URLs are supported.`, true);
    }

    // Defense-in-depth: SSRF + blocklist. The filter handles approval triage in approval mode;
    // open mode has no allowlist. Private hosts and blocked domains are always rejected here.
    if (isPrivateHost(url.hostname)) return textResult('Internal addresses are not allowed.', true);
    if (this.policy.blocked_domains.some((p) => matchDomain(url.hostname, p))) {
      return textResult(`Domain "${url.hostname}" is blocked.`, true);
    }

    // Strip query strings if policy says so
    if (!this.policy.allow_query_strings) {
      url.search = '';
      url.hash = '';
    }

    // Fetch via client method
    let fetchResult: FetchResult;
    try {
      fetchResult = await this.fetch({
        url: url.toString(),
        pipelines: parsed.data.pipelines,
      });
    } catch (err) {
      this.log.warn({ url: url.toString(), err }, 'web-fetch request failed');
      return textResult(
        `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }

    // Write files to staging/in
    const written = writeResultFiles(
      call.stagingDir,
      url.toString(),
      fetchResult,
    );

    // Format response
    const isBinary = fetchResult.encoding === 'base64';
    const lines = [
      `Title: ${fetchResult.meta.title || '(none)'}`,
      `URL: ${fetchResult.meta.url}`,
      `Content-Type: ${fetchResult.meta.contentType}`,
      `Fetched: ${fetchResult.meta.fetchedAt}`,
      '',
      'Files written:',
    ];
    for (const [key, info] of Object.entries(written)) {
      if (key === 'meta') {
        lines.push(`  ${info.path}`);
      } else if (isBinary) {
        const bytes = fetchResult.meta.sizes[key]?.bytes ?? 0;
        lines.push(`  ${info.path} (${bytes} bytes)`);
      } else {
        lines.push(`  ${info.path} (${info.tokens} tokens)`);
      }
    }
    lines.push('', 'Use the Read tool to access these files.');

    this.log.info(
      { url: url.toString(), files: Object.keys(written) },
      'web-fetch completed',
    );
    return textResult(lines.join('\n'));
  }

  // ---------------------------------------------------------------------------
  // Client method — SSRF protection, no domain policy
  // ---------------------------------------------------------------------------

  /** Fetch a URL via the web-fetch subprocess. Applies SSRF protection but not domain policy. */
  async fetch(req: FetchRequest): Promise<FetchResult> {
    if (!baseUrl) {
      throw new Error('web-fetch service is not running');
    }

    // SSRF check (security boundary, always applied)
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new Error(`Invalid URL: ${req.url}`);
    }
    if (isPrivateHost(url.hostname)) {
      throw new Error('Internal addresses are not allowed');
    }

    const responseBody = await httpPost(`${baseUrl}/fetch`, {
      url: req.url,
      pipelines: req.pipelines,
    });

    return FetchResultSchema.parse(JSON.parse(responseBody));
  }
}

// ---------------------------------------------------------------------------
// Extension definition
// ---------------------------------------------------------------------------

export const webFetch = defineExtension({
  name: 'web-fetch',
  configSchema: WebFetchPolicySchema,
  secretsSchema: z.object({}),

  async onServerStart(log) {
    // SIDE EFFECT: Captures logger for async subprocess event handlers.
    serverLog = log;
    // Let a startup failure propagate. The registry logs it and surfaces this
    // extension in the boot banner — a dead service means web__fetch is
    // unavailable for every agent, so operators must see it, not have it buried
    // in the log. (On full-network spawns the built-in WebFetch remains as a
    // fallback; under the firewall there's no web fetch at all.)
    try {
      await spawnService(log);
    } catch (err) {
      throw new Error(
        `web__fetch unavailable for all agents — ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  },

  async onServerStop(_log) {
    if (serviceProcess) {
      serviceProcess.kill();
      serviceProcess = null;
      baseUrl = null;
    }
  },

  create: (ctx) => new WebFetchExtension(ctx),
});

export { WebFetchExtension };
