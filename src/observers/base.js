// Stream B — SEAL v0.3.0 "Eye" layer — abstract Observer base class.
//
// Per docs/AGENT-SYSTEM-DESIGN.md §3.1. Every concrete observer (git,
// calendar, telegram, filesystem, ...) extends this class, implements
// start(), and calls this.emit({ kind, data }) when something happens.
//
// The Observer does NOT extend EventEmitter. It holds a reference to an
// EventBus and delegates dispatch to bus.observe(). This is intentional:
//   - subclasses think in Observer terms ("emit an observation"),
//     not EventEmitter terms ("fire a named event to my own listeners").
//   - the three-tier dispatch + persistence all happens inside the bus,
//     so every observer gets it for free.

export class Observer {
  /**
   * @param {string} name - source identifier (used as the 'source' field in events)
   * @param {import('../event-bus.js').EventBus} eventBus - the shared bus instance
   */
  constructor(name, eventBus) {
    if (new.target === Observer) {
      throw new Error('Observer is abstract — extend it');
    }
    if (!name || typeof name !== 'string') {
      throw new Error('Observer requires a name');
    }
    if (!eventBus || typeof eventBus.observe !== 'function') {
      throw new Error('Observer requires an EventBus with an observe() method');
    }
    this.name = name;
    this.eventBus = eventBus;
    this.started = false;
  }

  /**
   * Set up watchers (hooks, timers, file watchers, polling loops, ...).
   * Subclasses MUST override. The base implementation throws to force it.
   */
  async start() {
    throw new Error(`${this.constructor.name}.start() not implemented`);
  }

  /**
   * Clean up watchers. No-op default so subclasses without teardown can skip it.
   * Sets this.started = false so the contract is consistent across subclasses.
   */
  async stop() {
    this.started = false;
  }

  /**
   * Emit a normalized observation. Subclasses call this with { kind, data }.
   * `source` is filled in from this.name; `timestamp` defaults to now inside
   * the bus. This method shadows EventEmitter.emit on purpose — Observer does
   * NOT extend EventEmitter, so there is no conflict.
   *
   * @param {object} event
   * @param {string} event.kind        - dot-namespaced, e.g. 'git.commit'
   * @param {object} [event.data]      - arbitrary JSON-serializable payload
   * @param {string} [event.timestamp] - optional ISO string override
   */
  emit(event) {
    if (!event || !event.kind) {
      console.warn(`[${this.name}] emit() called without a kind — dropped`);
      return;
    }
    this.eventBus.observe({
      source: this.name,
      kind: event.kind,
      data: event.data || {},
      timestamp: event.timestamp,
    });
  }
}
