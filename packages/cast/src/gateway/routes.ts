/**
 * Routes — generic routes.json reader.
 *
 * Per-transport schemas live on each transport's `defineTransport({...})`
 * definition (see `packages/cast/src/transports/`). This file just reads
 * the file and returns it as `Record<transportName, unknown>`; the
 * transport registry validates each slice via the matching configSchema.
 */
import path from 'path';
import { z } from 'zod';

import { CONFIG_DIR } from '../config.js';
import { readParsed } from '../lib/config-reader.js';

const RoutesSchema = z.record(z.string(), z.unknown());
export type Routes = z.infer<typeof RoutesSchema>;

const DEFAULT_ROUTES: Routes = {};

/** Load routes from <CAST_CONFIG_DIR>/routes.json. Cached by FileWatcher. Returns empty routes if missing or invalid. */
export function loadRoutes(): Routes {
  return readParsed(path.join(CONFIG_DIR, 'routes.json'), RoutesSchema, DEFAULT_ROUTES);
}
