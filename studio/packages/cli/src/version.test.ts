import { describe, expect, it } from 'vitest';
import { readOwnPackageInfo } from './version.js';

describe('readOwnPackageInfo', () => {
  it('reads the real name and version from package.json', () => {
    const info = readOwnPackageInfo();
    expect(info.name).toBe('@autonomy-studio/cli');
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
