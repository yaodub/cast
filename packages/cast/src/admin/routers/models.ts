/**
 * Models router — Anthropic model catalog + [1m] LUT from cast-services.
 *
 * The fetcher (lib/cast-services.ts) owns caching, retry, and snapshot
 * fallback. This router is a passthrough.
 */
import { fetchModels } from '../../lib/cast-services.js';
import { adminProcedure, router } from '../trpc.js';

export const modelsRouter = router({
  list: adminProcedure.query(() => fetchModels()),
});
