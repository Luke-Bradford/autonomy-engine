import { readFileSync } from 'node:fs';
import { arch } from 'node:process';
import { BuildInfoSchema, type BuildInfo } from '@autonomy-studio/shared';

/** What a checkout without a release manifest reports. */
export const DEV_VERSION = '0.0.0-dev';

/**
 * Read the build's identity, or a dev placeholder.
 *
 * TOTAL by construction: absent, unreadable, unparseable and wrong-shape all
 * return the placeholder rather than throwing. This runs on the boot path, and a
 * server that refuses to start because a metadata file is malformed would turn a
 * cosmetic problem into an outage — including, in phase 2, one where the file is
 * half-written because an update is mid-flight.
 */
export function resolveBuildInfo(manifestPath: string): BuildInfo {
  const fallback: BuildInfo = {
    version: DEV_VERSION,
    commit: 'dev',
    builtAt: new Date(0).toISOString(),
    arch,
  };
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = BuildInfoSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
