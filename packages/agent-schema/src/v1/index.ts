import semver from 'semver';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Agent spec version. Cast server checks compatibility against this. */
export const SPEC_VERSION = '1.0.0';

/** Semver range of agent formats this version of the codebase supports. */
export const SUPPORTED_RANGE = '>=1.0.0 <2.0.0';

/** Check whether an agent's stamped format version is compatible with this codebase. */
export function isCompatible(agentFormat: string): boolean {
  return semver.satisfies(agentFormat, SUPPORTED_RANGE);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Subdirectories under blueprint/ created at init time. */
export const BLUEPRINT_SUBDIRS = [
  'identity',
  'channels',
  'props',
  'service',
  'assets',
] as const;
/** Instance-owned directories — created once, never overwritten by restamp. */
export const INSTANCE_LAYERS = [
  'config',
  'state',
  'home',
  'memory',
  'ext',
] as const;
/** Ephemeral directories — runtime only, not portable. */
export const EPHEMERAL_LAYERS = [
  'sessions',
  'mcp',
  'logs',
  'staging',
  '.admin',
] as const;

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const PROFILE_NAMES = ['standard', 'minimal'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Structural metadata for each agent's manifest.json.
 *
 * The manifest is open-by-design — `.passthrough()` accepts any additional
 * keys. Tools that generate agents may add
 * provenance fields like `template`, `templateVersion`, `templateCommit`,
 * `stampedAt`; the server preserves them but does not require them. The
 * base spec defines only the fields below.
 */
export const AgentManifestSchema = z
  .object({
    spec: z.string(),
    /** Agent alias — lowercase alphanumeric + hyphens. Operator-editable, used as bus label + ACL key. Required. */
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    /** Public key fingerprint — truncated SHA-256 of DER-encoded Ed25519 pubkey. */
    pubkey: z.string().optional(),
    /** Human-readable description for bus advertisement and admin UI. */
    description: z.string().optional(),
    /**
     * Lifecycle status. Absence = ready. `draft` = being composed in the
     * Design console. No other literals exist.
     */
    status: z.literal('draft').optional(),
  })
  .passthrough();
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

/** Runtime backup config (config/agent.json → backup). */
export const BackupConfigSchema = z.object({
  retain: z.number().int().min(1),
  hour: z.number().int().min(0).max(23).default(3),
});
export type BackupConfig = z.infer<typeof BackupConfigSchema>;

/** File-watch tunables (config/agent.json → fileWatch). Task 77 Phase 3+. */
export const FileWatchConfigSchema = z.object({
  /** Token threshold for inlining row bodies in <cast:watch> tags.
   *  `0` disables inlining entirely (agent re-reads on receipt). Higher
   *  values save Read round-trips at the cost of context size. Range 0–50000. */
  maxPreviewTokens: z.number().int().min(0).max(50_000).default(1000),
  /** Max active watches per runner (channel + participant pair). Cap exists
   *  to keep prompt context bounded. Range 1–50. Phase 4 enforces at tool
   *  registration; Phase 3 ships the field for forward-compat. */
  maxWatchesPerChannel: z.number().int().min(1).max(50).default(3),
}).strict();
export type FileWatchConfig = z.infer<typeof FileWatchConfigSchema>;

// ---------------------------------------------------------------------------
// Unlockable field pattern
// ---------------------------------------------------------------------------

/**
 * A string array that can be locked (bare array) or unlocked ({ unlocked: true, value: [...] }).
 * When unlocked, the admin can extend the list via provisions.json.
 */
export const UnlockableStringArraySchema = z.union([
  z.array(z.string()),
  z.object({ unlocked: z.boolean(), value: z.array(z.string()) }),
]);
export type UnlockableStringArray = z.infer<typeof UnlockableStringArraySchema>;

/** Check whether an unlockable field allows admin override. */
export function isUnlocked(field: UnlockableStringArray): field is { unlocked: boolean; value: string[] } {
  return !Array.isArray(field) && field.unlocked === true;
}

/** Extract the effective array from an unlockable field (ignoring unlock metadata). */
export function unlockableValue(field: UnlockableStringArray): string[] {
  return Array.isArray(field) ? field : field.value;
}

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

/** Resource slot declaration in capabilities.json — vendor declares what the agent needs. */
export const ResourceSlotSchema = z.object({
  description: z.string().optional(),
  access: z.enum(['ro', 'rw']).default('ro'),
  required: z.boolean().default(false),
});
export type ResourceSlot = z.infer<typeof ResourceSlotSchema>;

/** Resource provision in provisions.json — admin fills in deployment-specific paths. */
export const ResourceProvisionSchema = z.union([
  z.string(),
  z.object({ path: z.string(), access: z.enum(['ro', 'rw']).optional() }),
]);
export type ResourceProvision = z.infer<typeof ResourceProvisionSchema>;

/** Resource mount entry — bare string (read-only path) or object with explicit access mode. Used internally by container runner. */
export const ResourceEntrySchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    access: z.enum(['ro', 'rw']).default('ro'),
  }),
]);
export type ResourceEntry = z.infer<typeof ResourceEntrySchema>;

// ---------------------------------------------------------------------------
// Pip schemas
// ---------------------------------------------------------------------------

/** Pip capabilities in capabilities.json — vendor declares package needs. */
export const PipCapabilitiesSchema = z.object({
  allowed_packages: z.array(z.string()).min(1),
  extra_packages: UnlockableStringArraySchema.default([]),
});
export type PipCapabilities = z.infer<typeof PipCapabilitiesSchema>;

/** Resolved pip config passed to MCP context (post-merge). */
export const PipConfigSchema = z.object({
  allowed_packages: z.array(z.string()).min(1),
});
export type PipConfig = z.infer<typeof PipConfigSchema>;

// ---------------------------------------------------------------------------
// MCP server schemas
// ---------------------------------------------------------------------------

/** Env slot in an MCP server declaration. Bare string = locked value. Object = operator-fillable. */
export const McpServerEnvSlotSchema = z.union([
  z.string(),
  z.object({
    unlocked: z.literal(true),
    value: z.string().default(''),
    required: z.boolean().default(false),
    description: z.string().optional(),
  }),
]);
export type McpServerEnvSlot = z.infer<typeof McpServerEnvSlotSchema>;

/** MCP server declaration in capabilities.json — vendor declares transport config and env slots. */
export const McpServerDeclarationSchema = z.object({
  transport: z.enum(['stdio', 'streamable-http', 'sse']),
  /** stdio: command to spawn. */
  command: z.string().optional(),
  /** stdio: arguments for the command. */
  args: z.array(z.string()).optional(),
  /** streamable-http / sse: URL to connect to. */
  url: z.string().optional(),
  /** Environment variable slots. Bare string = locked (vendor-hardcoded). Object with unlocked: true = operator fills value. */
  env: z.record(z.string(), McpServerEnvSlotSchema).default({}),
});
export type McpServerDeclaration = z.infer<typeof McpServerDeclarationSchema>;

/** Operator-provisioned MCP server env values (config/mcp-servers.json). Keyed by server name. */
export const McpServerSecretsSchema = z.record(
  z.string(),
  z.record(z.string(), z.string()),
);
export type McpServerSecrets = z.infer<typeof McpServerSecretsSchema>;

/** Entry in `agent.json::modelOverrides`. Channel-keyed selection of a specific model
 *  for a given channel (and optionally a specific lifecycle phase within that channel).
 *  Resolution rule: every specified dimension must match; most-specific match wins
 *  (count of specified dimensions). Channel-only entries match all phases on that channel. */
export const ModelOverrideEntrySchema = z
  .object({
    /** Required. Blueprint channel name; console channels (`__`-prefixed) are rejected. */
    channel: z
      .string()
      .min(1)
      .refine((s) => !s.startsWith('__'), {
        message: 'Console channels (prefix `__`) cannot be override targets',
      }),
    /** Optional lifecycle phase. Omitted = matches all phases on the channel. */
    phase: z.enum(['bootstrap', 'cleanup']).optional(),
    /** Claude model identifier to use when this entry matches. */
    model: z.string().min(1),
  })
  .strict();
export type ModelOverrideEntry = z.infer<typeof ModelOverrideEntrySchema>;

/** Server-only agent config (config/agent.json). Runtime knobs only — no blueprint dependency. */
export const AgentConfigSchema = z
  .object({
    model: z.string().optional(),
    /** Per-channel (and optionally per-phase) model overrides. See `ModelOverrideEntrySchema`. */
    modelOverrides: z.array(ModelOverrideEntrySchema).optional(),
    /** Container network isolation mode. Controls iptables rules inside the container.
     *  "sdk-only" (default): only Anthropic API endpoints reachable.
     *  "full": no firewall, full internet access.
     *  "none": all egress blocked. */
    containerNetwork: z.enum(['sdk-only', 'full', 'none']).optional(),
    /** Additional endpoints the container can reach (domain:port pairs).
     *  Only effective when containerNetwork is "sdk-only". */
    containerAllowedEndpoints: z.array(z.string()).default([]),
    /** Stream intermediate model output (tool calls, reasoning) to the user in production
     *  conversations. Default `true`. Separate from `showConsoleSteps`, which controls
     *  the per-agent Design and Configure consoles. */
    showSteps: z.boolean().optional(),
    /** Stream intermediate model output in this agent's Design and Configure consoles.
     *  Default `true`. Separate from `showSteps` (production); the two are independent
     *  so an operator can keep production output clean while keeping authoring transparent
     *  (or vice versa). The server-scope manager consoles (DM/CM/SM) follow a separate
     *  server-level `showManagerSteps` toggle. */
    showConsoleSteps: z.boolean().optional(),
    /** IANA timezone for the agent (e.g. "America/New_York"). Falls back to server timezone. */
    timezone: z.string().optional(),
    backup: BackupConfigSchema.optional(),
    /** File-watch tunables (Task 77). */
    fileWatch: FileWatchConfigSchema.optional(),
    /** Max user-visible bytes per agent output (post-strip of `<cast:internal>` blocks).
     *  Default 32_768. Outputs exceeding this are blackholed and the agent is told to
     *  use `/staging/out/` for long content. */
    maxOutputBytes: z.number().int().min(1024).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const overrides = config.modelOverrides;
    if (!overrides) return;
    const seen = new Map<string, number>();
    for (const [i, entry] of overrides.entries()) {
      const key = `${entry.channel} ${entry.phase ?? ''}`;
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modelOverrides', i],
          message: `duplicate override for channel="${entry.channel}"${
            entry.phase ? ` phase="${entry.phase}"` : ''
          } (already specified at index ${first})`,
        });
      } else {
        seen.set(key, i);
      }
    }
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Agent capabilities (blueprint/props/capabilities.json). Vendor-owned, overwritten on restamp. */
export const CapabilitiesSchema = z
  .object({
    disabled_tools: z.array(z.string()).default([]),
    /** Admin-extensible disabled tools. Unlocked = admin can add via provisions.json. */
    additional_disabled_tools: UnlockableStringArraySchema.default([]),
    /** pip package management capabilities. */
    pip: PipCapabilitiesSchema.optional(),
    /** Resource slot declarations — vendor declares what the agent needs, admin provisions paths. */
    resources: z.record(z.string(), ResourceSlotSchema).default({}),
    /** Extension declarations — each key is an extension name with enabled flag + config. */
    extensions: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean().default(false),
          })
          .passthrough(),
      )
      .default({}),
    /** External MCP server declarations — each key is a server name with transport config and env slots. */
    mcp_servers: z.record(z.string(), McpServerDeclarationSchema).default({}),
  })
  .strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Admin provisions (config/provisions.json). Admin-owned, never touched by restamp. */
export const ProvisionsSchema = z
  .object({
    /** Resource path bindings — key matches a slot name from capabilities.json. */
    resources: z.record(z.string(), ResourceProvisionSchema).default({}),
    /** Additional pip packages (only accepted if extra_packages is unlocked in capabilities). */
    pip: z.object({
      extra_packages: z.array(z.string()).default([]),
    }).optional(),
    /** Additional disabled tools (only accepted if additional_disabled_tools is unlocked in capabilities). */
    additional_disabled_tools: z.array(z.string()).default([]),
  })
  .strict();
export type Provisions = z.infer<typeof ProvisionsSchema>;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export {
  BUILT_IN_TOOLS,
  type BuiltInToolName,
  TOOL_DOMAINS,
  type ToolDomain,
  isToolDisabled,
} from './tools.js';

export { FirewallSchema, type Firewall } from './firewall.js';

export {
  StdinAttachmentSchema,
  ContainerInputSchema,
  StdinMessageSchema,
  ContainerOutputSchema,
  type StdinAttachment,
  type ContainerInput,
  type StdinMessage,
  type ContainerOutput,
} from './container-io.js';
