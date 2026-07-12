import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name: string;
  version: string;
}

/** Reads this package's own name + version straight from its package.json. */
export function readOwnPackageInfo(): PackageJson {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as PackageJson;
  return { name: parsed.name, version: parsed.version };
}
