import os from 'os';
import path from 'path';

const home = os.homedir();

export const DEFAULT_REVIEW_REPOS = [
  {
    name: 'app-mobile',
    id: 'f25aac20-9d94-441e-8f13-e09b0d56554d',
    projectDir: path.join(home, 'projects', 'prs_smartesales_flutter'),
    skill: 'smart-review',
    pair: 'api-legada',
    stack: 'flutter',
  },
  {
    name: 'api-legada',
    id: 'dd384567-e980-462d-a52a-b3c5447f8d4e',
    projectDir: path.join(home, 'projects', 'api-legada'),
    skill: 'yh-smart-review',
    pair: 'app-mobile',
    stack: 'node',
  },
  {
    name: 'app-web',
    id: 'eaaee050-e282-4a00-a3cf-f918bcb3b719',
    projectDir: path.join(home, 'projects', 'app-web'),
    skill: 'vue-review',
    pair: 'api-nova',
    stack: 'vue',
  },
  {
    name: 'api-nova',
    id: '4e35764d-940d-447c-8356-e91d0b06ade3',
    projectDir: path.join(home, 'projects', 'api-nova'),
    skill: 'yh-smart-review',
    pair: 'app-web',
    stack: 'node',
  },
];

export function resolveReviewRepos(overrides = []) {
  const byName = new Map(DEFAULT_REVIEW_REPOS.map((repo) => [repo.name, { ...repo }]));
  for (const override of overrides || []) {
    if (!override?.name) continue;
    byName.set(override.name, { ...(byName.get(override.name) || {}), ...override });
  }
  return [...byName.values()].filter((repo) => repo.enabled !== false && repo.id && repo.projectDir);
}
