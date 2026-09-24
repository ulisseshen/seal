import fs from 'fs';
import os from 'os';
import path from 'path';
import { runSinglePrReview } from './azure-pr-review.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs), []),
);
if (!args.repo || !args.pr) {
  console.error('usage: node src/sensors/pr-review-run.js --repo <repo-name> --pr <id>');
  process.exit(2);
}

let sensorCfg = {};
try {
  sensorCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'seal', 'ingest.json'), 'utf8')).sensors || {};
} catch {}

if (args['requeue-parts']) {
  const { requeueReviewParts } = await import('./azure-pr-review.js');
  const parts = String(args['requeue-parts']).split(',').map(Number).filter(Number.isFinite);
  console.log(JSON.stringify(await requeueReviewParts({ repoName: args.repo, prId: Number(args.pr), parts, sensorCfg }), null, 2));
  process.exit(0);
}

const timeoutMs = (Number(args['timeout-min']) || 45) * 60 * 1000;
const outcome = await runSinglePrReview({ repoName: args.repo, prId: Number(args.pr), sensorCfg, timeoutMs });
console.log(JSON.stringify(outcome, null, 2));
process.exit(0);
