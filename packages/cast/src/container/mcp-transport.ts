import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

import { z } from 'zod';

import {
  AGENTS_DIR,
  CONFIG_DIR,
  CONTAINER_IMAGE,
  CONTAINER_RUNTIME,
  RUNTIME_BINARY,
  RUNTIME_VERSION,
} from '../config.js';
import { logger } from '../logger.js';

/**
 * MCP transport resolution — decides, per host, how the Cast server exposes its
 * MCP servers to agent containers.
 *
 * Two physical questions determine the transport, and neither is a property of
 * the OS string — they're properties of the runtime + the agents-dir filesystem:
 *
 *   1. Can a host-created AF_UNIX socket, bind-mounted into a container, be
 *      connected to from inside it? True on native-Linux daemons with a real-FS
 *      mount source (bare metal, and native docker inside a WSL2 distro) and on
 *      Apple Container. False on every VM / file-sharing boundary (Docker
 *      Desktop, or a native daemon whose mount source is a 9p/drvfs/virtiofs
 *      path) — the socket inode can't cross.
 *   2. If we fall back to TCP (reached via host.docker.internal), which host
 *      bind address does the container actually reach? Docker Desktop NATs the
 *      connection through the host's own loopback, so 127.0.0.1 works. A native
 *      Linux daemon reaches the host on the bridge gateway, where a loopback
 *      listener is unreachable — so the host must bind the gateway IP.
 *
 * The set of runtimes that share each behavior is open and growing, so rather
 * than enumerate them we PROBE the two behaviors once at startup and cache the
 * result. This mirrors RUNTIME_SUPPORTS_CAP_ADD (config.ts), which probes the
 * flag it needs instead of inferring it from a version number.
 */

const McpTransportSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('socket') }),
  z.object({ mode: z.literal('tcp'), bindAddr: z.string() }),
]);

/** How the host exposes its MCP servers to agent containers. */
export type McpTransport = z.infer<typeof McpTransportSchema>;

// SIDE EFFECT: module-scoped cache of the one-time startup resolution. Every MCP
// server start (agent cast server, external-MCP proxy, console server) reads
// this single resolved value rather than re-probing. Written once by
// resolveMcpTransport() during bootstrap. The default is 'socket' — correct for
// the non-Docker-Desktop majority (Apple Container, native Linux, native docker
// in WSL2) — so a read before resolution is never catastrophically wrong.
let resolved: McpTransport = { mode: 'socket' };

/** The resolved MCP transport. Valid after resolveMcpTransport() runs at startup. */
export function mcpTransport(): McpTransport {
  return resolved;
}

// ---------------------------------------------------------------------------
// Cache — keyed on an environment fingerprint so we re-probe only on change
// ---------------------------------------------------------------------------

const CACHE_VERSION = 1;

const CacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  fingerprint: z.string(),
  transport: McpTransportSchema,
});

const cachePath = () => path.join(CONFIG_DIR, 'mcp-transport.json');

/** Re-probe when any input that could change the answer changes: the runtime,
 *  its version, the agent image, or the agents-dir filesystem (its device id). */
function fingerprint(): string {
  let device = 'unknown';
  try {
    device = String(fs.statSync(AGENTS_DIR).dev);
  } catch {
    /* dir may not exist yet — fingerprint still stable enough to cache */
  }
  return [CACHE_VERSION, process.platform, RUNTIME_BINARY, RUNTIME_VERSION, CONTAINER_IMAGE, device].join('|');
}

function readCache(fp: string): McpTransport | null {
  try {
    const parsed = CacheSchema.safeParse(JSON.parse(fs.readFileSync(cachePath(), 'utf8')));
    if (parsed.success && parsed.data.fingerprint === fp) return parsed.data.transport;
  } catch {
    /* missing or corrupt — fall through to re-probe */
  }
  return null;
}

function writeCache(fp: string, transport: McpTransport): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify({ version: CACHE_VERSION, fingerprint: fp, transport }, null, 2));
  } catch (err) {
    logger.debug({ err }, 'Could not persist MCP transport cache (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Probes — each spawns one throwaway container against the real agent image
// ---------------------------------------------------------------------------

/** Run a throwaway probe container; resolve with its exit code. The container
 *  command self-exits within seconds, so `--rm` cleans it up; the outer timeout
 *  is only a backstop for a stuck runtime. */
function runProbeContainer(args: string[], timeoutMs = 20000): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(RUNTIME_BINARY, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(125);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** Probe 1 — is a bind-mounted unix socket connectable from a container? The
 *  socket is created on the real agents-dir filesystem, so a 9p/drvfs/virtiofs
 *  mount source is caught too. */
async function probeSocketMountable(): Promise<boolean> {
  const probeDir = path.join(AGENTS_DIR, `.mcp-probe-${process.pid}`);
  const sockPath = path.join(probeDir, 'probe.sock');
  fs.mkdirSync(probeDir, { recursive: true });
  try {
    fs.chmodSync(probeDir, 0o777);
  } catch {
    /* best effort — the container runs as a non-root user */
  }

  const server = net.createServer((conn) => {
    // The probe container connects and exits immediately, resetting this
    // socket. A 'error' event with no listener is promoted to an uncaught
    // exception (which would crash startup), so swallow the expected reset.
    conn.on('error', () => {});
    conn.end('ok');
  });
  try {
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(sockPath, () => {
        try {
          fs.chmodSync(sockPath, 0o777);
        } catch {
          /* best effort */
        }
        res();
      });
    });
    // Listen succeeded; from here a late server error must not crash a
    // best-effort probe.
    server.on('error', () => {});
    // A successful connect() means the inode crossed the mount and is a live
    // socket inside the guest.
    const connect = `const s=require('net').connect('/probe/probe.sock');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),5000);`;
    const code = await runProbeContainer([
      'run', '--rm', '-v', `${probeDir}:/probe`, '--entrypoint', 'node', CONTAINER_IMAGE, '-e', connect,
    ]);
    return code === 0;
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    try {
      fs.rmSync(probeDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** The default bridge's gateway IP, or null if it can't be read. */
function dockerBridgeGateway(): string | null {
  try {
    const out = execFileSync(
      RUNTIME_BINARY,
      ['network', 'inspect', 'bridge', '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Can a container reach a host listener bound to `bindAddr` via host.docker.internal? */
async function tcpReachable(bindAddr: string): Promise<boolean> {
  const server = http.createServer((_req, res) => res.writeHead(200).end('ok'));
  // The probe container fires one request then exits, resetting the connection.
  // Swallow client/socket errors so an expected reset can't crash startup.
  server.on('clientError', (_err, socket) => socket.destroy());
  let port: number;
  try {
    port = await new Promise<number>((res, rej) => {
      server.once('error', rej);
      server.listen(0, bindAddr, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') res(addr.port);
        else rej(new Error('no port assigned'));
      });
    });
    server.on('error', () => {});
  } catch {
    // Host can't bind this address (e.g. the bridge-gateway IP isn't a host
    // interface under Docker Desktop) — treat as unreachable.
    await new Promise<void>((res) => server.close(() => res()));
    return false;
  }
  const get = `const r=require('http').get('http://host.docker.internal:${port}/',()=>process.exit(0));r.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),5000);`;
  try {
    const code = await runProbeContainer([
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'node', CONTAINER_IMAGE, '-e', get,
    ]);
    return code === 0;
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

/** Probe 2 — the host bind address a container can reach, picking the least
 *  exposed candidate that works. */
async function probeTcpBindAddr(): Promise<string> {
  const candidates = ['127.0.0.1', dockerBridgeGateway(), '0.0.0.0'].filter(
    (a): a is string => a !== null,
  );
  for (const addr of candidates) {
    if (await tcpReachable(addr)) {
      if (addr === '0.0.0.0') {
        logger.warn(
          'MCP TCP listener bound to 0.0.0.0 — reachable beyond this host (the bridge gateway was not bindable). Prefer socket mode where possible.',
        );
      }
      return addr;
    }
  }
  logger.warn('No MCP TCP bind address was reachable from a probe container; defaulting to 127.0.0.1');
  return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Transport to use when probing is impossible — the platform's most likely
 *  answer: Docker Desktop on macOS reaches the host on loopback, everything else
 *  does socket. Always logged, so a fallback never passes silently. */
function heuristicFallback(): McpTransport {
  return process.platform === 'darwin' && CONTAINER_RUNTIME === 'docker'
    ? { mode: 'tcp', bindAddr: '127.0.0.1' }
    : { mode: 'socket' };
}

async function computeMcpTransport(): Promise<McpTransport> {
  // Apple Container passes the socket inode through its file sharing
  // (empirically), and its host.docker.internal TCP path is unreliable — so it
  // is always socket, no probe needed.
  if (CONTAINER_RUNTIME === 'apple-container') return { mode: 'socket' };

  const fp = fingerprint();
  const cached = readCache(fp);
  if (cached) return cached;

  let transport: McpTransport;
  try {
    transport = (await probeSocketMountable())
      ? { mode: 'socket' }
      : { mode: 'tcp', bindAddr: await probeTcpBindAddr() };
  } catch (err) {
    transport = heuristicFallback();
    logger.warn({ err, transport }, 'MCP transport probe failed; using platform heuristic');
  }
  writeCache(fp, transport);
  return transport;
}

/** Warn-only self-check: can a container BEHIND the sdk-only egress firewall still reach
 *  the host MCP server? The probes above run UNRESTRICTED containers, so they validate
 *  transport selection but not the firewalled path real agents take — the exact blind spot
 *  that let a mis-pinned carve-out silently strip every mcp__* tool. This applies the same
 *  narrow carve-out entrypoint.sh installs (resolve host.docker.internal, --dport scoped)
 *  plus the final REJECT, then connects. Never alters the resolved transport. */
async function firewalledMcpReachable(bindAddr: string): Promise<boolean> {
  const server = http.createServer((_req, res) => res.writeHead(200).end('ok'));
  server.on('clientError', (_err, socket) => socket.destroy());
  let port: number;
  try {
    port = await new Promise<number>((res, rej) => {
      server.once('error', rej);
      server.listen(0, bindAddr, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') res(addr.port);
        else rej(new Error('no port assigned'));
      });
    });
    server.on('error', () => {});
  } catch {
    await new Promise<void>((res) => server.close(() => res()));
    return false;
  }
  const getJs =
    `const r=require('http').get('http://host.docker.internal:'+process.env.PP+'/',()=>process.exit(0));` +
    `r.on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),5000);`;
  // Same rules entrypoint.sh's allow_mcp_host installs, then the REJECT, then the connect.
  const sh =
    `iptables -A OUTPUT -o lo -j ACCEPT; ` +
    `for ip in $(getent ahostsv4 host.docker.internal | awk '{print $1}' | sort -u); do ` +
    `iptables -A OUTPUT -p tcp -d "$ip" --dport "$PP" -j ACCEPT; done; ` +
    `iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable; ` +
    `node -e "$GETJS"`;
  try {
    const code = await runProbeContainer([
      'run', '--rm', '--cap-add=NET_ADMIN', '--cap-add=NET_RAW',
      '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PP=${port}`, '-e', `GETJS=${getJs}`,
      '--entrypoint', 'sh', CONTAINER_IMAGE, '-c', sh,
    ]);
    return code === 0;
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

/**
 * Resolve the MCP transport for this host and cache it for every MCP server
 * start. Call once during server bootstrap, after the container runtime is
 * confirmed up and before any agent spawns.
 */
export async function resolveMcpTransport(): Promise<void> {
  // SIDE EFFECT: writes the module-scoped `resolved` value documented above.
  // This is its single write site.
  resolved = await computeMcpTransport();
  // Warn-only: real agents run behind the sdk-only firewall, which the selection probes
  // never exercise. If the firewalled path can't reach the host, agents boot with ZERO
  // mcp__* tools — surface that loudly rather than letting it fail silently. Runs on every
  // startup when TCP is in play (Docker-only), so a broken image rebuild under an unchanged
  // tag is caught even on a warm transport cache. Never throws, never changes `resolved`.
  if (resolved.mode === 'tcp') {
    try {
      if (!(await firewalledMcpReachable(resolved.bindAddr))) {
        logger.warn(
          { bindAddr: resolved.bindAddr },
          'MCP TCP is unreachable THROUGH the sdk-only egress firewall — agents may boot with no mcp__* tools. Run tools/diagnose-mcp-transport.sh (PROBE 3) to inspect the carve-out.',
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Firewalled MCP reachability self-check could not run (non-fatal)');
    }
  }
}
