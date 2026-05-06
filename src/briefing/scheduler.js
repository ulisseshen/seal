/**
 * BriefingScheduler — cron-based scheduler that triggers the daily briefing.
 *
 * Uses cron-parser to calculate next fire time and schedules via setTimeout.
 * Supports manual triggering via fireNow() and handles briefing button callbacks.
 */

import { CronExpressionParser } from 'cron-parser';

export class BriefingScheduler {
  /**
   * @param {import('./builder.js').BriefingBuilder} builder
   * @param {import('../gateway/router.js').GatewayRouter} gateway
   * @param {object} [config]
   * @param {string} [config.cron] - Cron expression (default: 9am Mon-Fri)
   * @param {string} [config.timezone] - IANA timezone (default: America/Sao_Paulo)
   * @param {boolean} [config.enabled] - Whether the scheduler is active
   */
  constructor(builder, gateway, config = {}) {
    this.builder = builder;
    this.gateway = gateway;
    this.config = {
      cron: config.cron || '0 9 * * 1-5',
      timezone: config.timezone || 'America/Sao_Paulo',
      enabled: config.enabled !== false,
    };
    this.timer = null;
    this._running = false;
  }

  /**
   * Start the scheduler. Calculates next fire time and sets a timeout.
   */
  start() {
    if (!this.config.enabled) {
      console.log('[seal:briefing] Scheduler disabled by config');
      return;
    }

    this._running = true;
    this._scheduleNext();
    console.log('[seal:briefing] Scheduler started');
  }

  /**
   * Stop the scheduler.
   */
  stop() {
    this._running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[seal:briefing] Scheduler stopped');
  }

  /**
   * Fire the briefing immediately (for testing or manual trigger).
   * @returns {Promise<{sections: any[], actions: any[], generatedAt: string}>}
   */
  async fireNow() {
    console.log('[seal:briefing] Firing briefing now...');
    try {
      const briefing = await this.builder.build();
      const message = this.builder.formatForGateway(briefing);
      await this.gateway.send(message);
      console.log(`[seal:briefing] Briefing sent (${briefing.sections.length} sections)`);
      return briefing;
    } catch (err) {
      console.error('[seal:briefing] Failed to fire briefing:', err.message);
      throw err;
    }
  }

  /**
   * Handle a briefing button callback from the gateway.
   * Called when user clicks a "briefing:<action>:<id>" button in Telegram.
   *
   * @param {string} action - Action type: 'done', 'snooze', 'snooze-all', 'details'
   * @param {string} itemId - Task or item ID
   */
  async handleBriefingAction(action, itemId) {
    console.log(`[seal:briefing] Handling action: ${action} for ${itemId}`);

    try {
      switch (action) {
        case 'done': {
          // Import dynamically to avoid circular deps
          const { updateStatus } = await import('../db.js');
          await updateStatus(itemId, 'done');
          console.log(`[seal:briefing] Task ${itemId} marked as done`);
          break;
        }

        case 'snooze': {
          // Snooze a single task by 1 hour
          const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const { db } = await import('../db.js');
          await db.run(
            `UPDATE tasks SET execute_at = ?, status = 'pending' WHERE id = ?`,
            [snoozeUntil, itemId]
          );
          console.log(`[seal:briefing] Task ${itemId} snoozed until ${snoozeUntil}`);
          break;
        }

        case 'snooze-all': {
          // Snooze all firing tasks by 1 hour
          const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          const { db } = await import('../db.js');
          await db.run(
            `UPDATE tasks SET execute_at = ?, status = 'pending' WHERE status = 'firing'`,
            [snoozeUntil]
          );
          console.log(`[seal:briefing] All firing tasks snoozed until ${snoozeUntil}`);
          break;
        }

        case 'details': {
          // Send detailed info about a task
          const { getTaskById } = await import('../db.js');
          const task = await getTaskById(itemId);
          if (task) {
            const detail = [
              `📋 <b>${task.summary}</b>`,
              task.detail ? `\n${task.detail}` : '',
              `\nStatus: ${task.status}`,
              `Prioridade: ${task.priority}`,
              task.execute_at ? `Execução: ${task.execute_at}` : '',
              task.project ? `Projeto: ${task.project}` : '',
            ].filter(Boolean).join('\n');

            await this.gateway.send({
              text: detail,
              html: detail,
              level: 'info',
              category: 'briefing',
            });
          }
          break;
        }

        default:
          console.warn(`[seal:briefing] Unknown action: ${action}`);
      }
    } catch (err) {
      console.error(`[seal:briefing] Action ${action} failed:`, err.message);
    }
  }

  /**
   * Wire up to receive briefing callbacks from the gateway.
   * Should be called after gateway is initialized.
   */
  wireCallbacks() {
    // Look for telegram plugin to listen for briefing callbacks
    const telegramPlugin = this.gateway.plugins?.get('telegram');
    if (telegramPlugin && typeof telegramPlugin.onCallback === 'function') {
      telegramPlugin.onCallback((event) => {
        if (event.type === 'briefing') {
          this.handleBriefingAction(event.action, event.id).catch(err => {
            console.error('[seal:briefing] Callback handling error:', err.message);
          });
        }
      });
      console.log('[seal:briefing] Briefing callbacks wired to telegram');
    }
  }

  // ─── Internal ──────────────────────────────────────────────

  _scheduleNext() {
    if (!this._running) return;

    try {
      const cron = CronExpressionParser.parse(this.config.cron, {
        tz: this.config.timezone,
      });
      const next = cron.next();
      const nextDate = next.toDate();
      const delayMs = nextDate.getTime() - Date.now();

      if (delayMs <= 0) {
        // If somehow in the past, skip to the one after
        const nextNext = cron.next();
        const nextNextDate = nextNext.toDate();
        const delayMs2 = nextNextDate.getTime() - Date.now();
        this._setTimer(delayMs2, nextNextDate);
      } else {
        this._setTimer(delayMs, nextDate);
      }
    } catch (err) {
      console.error('[seal:briefing] Failed to parse cron expression:', err.message);
    }
  }

  _setTimer(delayMs, nextDate) {
    // Cap setTimeout at 24h to avoid Node.js 32-bit int overflow (max ~24.8 days)
    // If delay is longer, we re-schedule after 24h
    const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

    if (delayMs > MAX_TIMEOUT) {
      console.log(`[seal:briefing] Next briefing at ${nextDate.toISOString()} (re-check in 24h)`);
      this.timer = setTimeout(() => this._scheduleNext(), MAX_TIMEOUT);
    } else {
      console.log(`[seal:briefing] Next briefing at ${nextDate.toISOString()} (in ${Math.round(delayMs / 60_000)}min)`);
      this.timer = setTimeout(async () => {
        try {
          await this.fireNow();
        } catch {
          // Error already logged in fireNow
        }
        // Schedule the next one
        this._scheduleNext();
      }, delayMs);
    }
  }
}
