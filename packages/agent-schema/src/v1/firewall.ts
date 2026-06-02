import { z } from 'zod';

/** Server-level firewall config (mnt/config/firewall.json). Controls which agents accept external traffic. */
export const FirewallSchema = z.object({
  mode: z.enum(['allow-all', 'deny-all']),
  except: z.array(z.string()).default([]),
});
export type Firewall = z.infer<typeof FirewallSchema>;
