// Prefixes every console line of the runner with the local date and time, so the log answers "when" on its own
// (runner.log is written by launchd from stdout/stderr, with no timestamps of its own).
import { format } from 'util';

const pad = (value, size = 2) => String(value).padStart(size, '0');

export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function withStamp(args, date = new Date()) {
  return `[${stamp(date)}] ${format(...args)}`;
}

for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(withStamp(args));
}
