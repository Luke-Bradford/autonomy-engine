import { describe, expect, it } from 'vitest';
import type { Pipeline } from '@autonomy-studio/shared';
import { existingFolderSpelling, folderNamesOf } from './pipelineFolders';

const inFolder = (folder: string | null) => ({ folder }) as Pipeline;

describe('pipeline folders (#1569)', () => {
  it('lists each folder once, in name order, without "no folder"', () => {
    expect(folderNamesOf([inFolder('Ops'), inFolder(null), inFolder('Demo'), inFolder('Ops')])).toEqual(
      ['Demo', 'Ops'],
    );
  });

  it('files a typed name under an existing folder of another case', () => {
    expect(existingFolderSpelling(['Demo', 'Ops'], 'ops')).toBe('Ops');
    expect(existingFolderSpelling(['Demo', 'Ops'], 'Sales')).toBe('Sales');
  });
});
