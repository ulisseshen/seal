const OWN_REPORTING = /^seal_(pr|prep)_/;

// Only a failure reaches the owner's Telegram: "working on" and "done" of background tasks are noise there.
export function shouldBroadcastLifecycle(task, phase) {
  if (OWN_REPORTING.test(String(task?.id || ''))) return false;
  if (task?.notify_channel === 'telegram') return false;
  return phase === 'failed';
}
