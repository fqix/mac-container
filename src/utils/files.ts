// Helpers for copying files between this Mac and a container; free of the vscode API for unit tests

import * as path from 'path';

export interface ContainerEntry {
  name: string;
  directory: boolean;
}

/** Parses `ls -1Ap` output: one entry per line, directories end with a slash */
export function parseListing(output: string): ContainerEntry[] {
  return output
    .split('\n')
    .filter((line) => line && line !== './' && line !== '../')
    .map((line) => (line.endsWith('/') ? { name: line.slice(0, -1), directory: true } : { name: line, directory: false }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

/** Container paths are always POSIX, whatever the host */
export function joinContainerPath(dir: string, name: string): string {
  return path.posix.join(dir, name);
}

export function parentContainerPath(dir: string): string {
  return path.posix.dirname(dir);
}

/** Picks name, "name (1)", "name (2)"... so downloads never overwrite local files */
export function uniqueLocalPath(dir: string, name: string, exists: (file: string) => boolean): string {
  const ext = path.extname(name);
  // extname is empty for dotfiles such as .bashrc, so they get "(1)" appended
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    if (!exists(candidate)) {
      return candidate;
    }
  }
}
