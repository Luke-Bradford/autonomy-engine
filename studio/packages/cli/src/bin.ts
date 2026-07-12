#!/usr/bin/env node
import { readOwnPackageInfo } from './version.js';

/**
 * Placeholder CLI entry — P0a only needs to prove the `bin` wiring works.
 * Real self-host / headless-run behaviour lands in a later phase.
 */
function main() {
  const { name, version } = readOwnPackageInfo();
  console.log(`${name} v${version}`);
}

main();
