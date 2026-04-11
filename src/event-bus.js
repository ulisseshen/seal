// Stream B — SEAL v0.3.0 "Eye" layer — in-process event bus.
//
// Thin wrapper around Node's built-in EventEmitter that ALSO persists
// every observation to the `events` table via insertEvent from src/db.js.
//
// Design notes:
//   - Three tiers of listener events so subscribers can pick their granularity:
//       'observation'                              → everything
//       'observation:<source>'                     → e.g. 'observation:git'
//       'observation:<source>:<kind>'              → e.g. 'observation:git:git.commit'
//   - Persistence is fire-and-forget. insertEvent already swallows errors and
//     returns null on failure; the .catch here is a belt-and-suspenders guard.
//   - observe() MUST NOT throw. Listener errors and DB errors are logged and
//     swallowed so a misbehaving subscriber cannot crash the observer that
//     fed it the event.

import { EventEmitter } from 'node:events';
import { insertEvent } from './db.js';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    // Room for future observers + the persistence listener + dashboard tails.
    this.setMaxListeners(50);
  }

  /**
   * Emit an observation.
   * Synchronously fires listeners AND fire-and-forget persists to the events table.
   * MUST NOT throw if the DB write (or a listener) fails. Log and continue.
   *
   * @param {object} event
   * @param {string} event.source      - e.g. 'git', 'calendar', 'telegram'
   * @param {string} event.kind        - dot-namespaced string, e.g. 'git.branch.created'
   * @param {object} [event.data]      - arbitrary JSON-serializable payload
   * @param {string} [event.timestamp] - ISO string; defaults to now
   */
  observe(event) {
    const stamped = {
      ...event,
      timestamp: (event && event.timestamp) || new Date().toISOString(),
    };

    // 1. In-process listeners (synchronous, receive the full event).
    //    Wrap the whole dispatch in try/catch so one throwing listener can't
    //    abort subsequent tiers or the persistence write.
    try {
      this.emit('observation', stamped);
    } catch (err) {
      console.warn(`[event-bus] listener error on 'observation':`, err.message);
    }
    try {
      this.emit(`observation:${stamped.source}`, stamped);
    } catch (err) {
      console.warn(
        `[event-bus] listener error on 'observation:${stamped.source}':`,
        err.message
      );
    }
    try {
      this.emit(`observation:${stamped.source}:${stamped.kind}`, stamped);
    } catch (err) {
      console.warn(
        `[event-bus] listener error on 'observation:${stamped.source}:${stamped.kind}':`,
        err.message
      );
    }

    // 2. Persistence (fire-and-forget).
    //    insertEvent already swallows errors internally; the .catch is a
    //    belt-and-suspenders guard in case a future refactor makes it throw.
    insertEvent(stamped).catch((err) => {
      console.warn(`[event-bus] persist error for ${stamped.kind}:`, err.message);
    });
  }
}

// Single process-wide instance — avoids passing the bus through every observer
// boot path. Tests can instantiate their own EventBus if they need isolation.
export const eventBus = new EventBus();
