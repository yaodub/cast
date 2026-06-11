// Single source for the Cast version the site displays (hero block, footer).
// Derives from the workspace package.json, which `pnpm version:set <semver>`
// bumps in lockstep — a release bump propagates here with no separate edit.
import { version } from '../package.json';

export const CAST_VERSION = `v${version}`;
