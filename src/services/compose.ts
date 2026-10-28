// container-compose helpers that do not depend on vscode: grouping containers and deriving project names.
// Naming follows container-compose 1.2.0 (ComposeProject.projectName / deriveProjectName).

import * as path from 'path';

import type { ContainerSummary } from '../models/types';

/** File names container-compose looks for, in order, when no --file is given */
export const COMPOSE_FILE_NAMES = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'];

export interface ComposeProject {
  name: string;
  containers: ContainerSummary[];
}

export interface GroupedContainers {
  projects: ComposeProject[];
  standalone: ContainerSummary[];
}

export function groupByComposeProject(containers: ContainerSummary[]): GroupedContainers {
  const projects = new Map<string, ContainerSummary[]>();
  const standalone: ContainerSummary[] = [];
  for (const c of containers) {
    if (c.composeProject) {
      const list = projects.get(c.composeProject) ?? [];
      list.push(c);
      projects.set(c.composeProject, list);
    } else {
      standalone.push(c);
    }
  }
  return {
    projects: [...projects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({
        name,
        containers: list.sort((a, b) => (a.composeService ?? a.id).localeCompare(b.composeService ?? b.id)),
      })),
    standalone,
  };
}

/**
 * Project name for a compose file run from its own directory: the top-level `name:` field if present,
 * otherwise the directory name with '.' replaced by '_'.
 */
export function composeProjectName(fileText: string, filePath: string): string {
  // Only a top-level key (no indentation) counts; values may be quoted
  const match = /^name:[ \t]*(['"]?)([^'"#\r\n]+?)\1[ \t]*(?:#.*)?$/m.exec(fileText);
  if (match) {
    return match[2].trim();
  }
  return path.basename(path.dirname(filePath)).replace(/\./g, '_');
}

export function isComposeFileName(fileName: string): boolean {
  return COMPOSE_FILE_NAMES.includes(fileName) || /^(docker-)?compose\..+\.ya?ml$/.test(fileName);
}
