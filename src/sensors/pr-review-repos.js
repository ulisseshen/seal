import os from 'os';
import path from 'path';

const REQUIRED_FIELDS = ['name', 'id', 'projectDir', 'skill'];

const expandHome = (dir) => (dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir);

export function resolveReviewRepos(repos = []) {
  return (repos || [])
    .filter((repo) => repo && repo.enabled !== false && REQUIRED_FIELDS.every((field) => repo[field]))
    .map((repo) => ({ ...repo, projectDir: expandHome(repo.projectDir), ...(repo.skillPath && { skillPath: expandHome(repo.skillPath) }) }));
}
