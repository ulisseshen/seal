/**
 * Callback handlers for Telegram inline button presses.
 *
 * Routes callback_query events back to the gateway plugin so that
 * pending confirmations are resolved and the original message is updated.
 */

/**
 * Set up callback_query and message handlers on the bot for the gateway.
 *
 * @param {import('node-telegram-bot-api')} bot
 * @param {import('./index.js').TelegramGateway} gateway
 */
export function setupCallbackHandlers(bot, gateway) {
  bot.on('callback_query', async (query) => {
    const { data, from, message } = query;

    try {
      // Answer the callback to remove the loading indicator on the client
      await bot.answerCallbackQuery(query.id);

      // Parse callback data
      // Formats:
      //   "action:<actionId>:<choice>"
      //   "briefing:<action>:<id>"
      //   "<raw>"
      const parts = data.split(':');
      const type = parts[0];

      if (type === 'action' && parts.length >= 3) {
        const actionId = parts[1];
        const choice = parts.slice(2).join(':'); // choice may contain colons

        const result = {
          actionId,
          choice,
          confirmedBy: from.username || from.first_name || String(from.id),
          confirmedAt: new Date().toISOString(),
        };

        // Resolve the pending confirmation
        gateway._resolveConfirmation(actionId, result);

        // Edit the original message to reflect the choice
        const choiceLabel = _findChoiceLabel(message, data);
        const updatedText = `${message.text}\n\n✅ ${result.confirmedBy} chose: ${choiceLabel || choice}`;

        try {
          await bot.editMessageText(updatedText, {
            chat_id: message.chat.id,
            message_id: message.message_id,
          });
        } catch {
          // Message may have been deleted or too old to edit
        }

        console.log(`[seal:gateway:telegram] Confirmation ${actionId} → ${choice} by ${result.confirmedBy}`);
      } else if (type === 'briefing' && parts.length >= 3) {
        const action = parts[1];
        const id = parts.slice(2).join(':');

        // Emit as a generic callback event for briefing actions
        gateway._emitCallback({ type: 'briefing', action, id, from, message });

        const updatedText = `${message.text}\n\n✅ ${action}: ${id}`;
        try {
          await bot.editMessageText(updatedText, {
            chat_id: message.chat.id,
            message_id: message.message_id,
          });
        } catch {}

        console.log(`[seal:gateway:telegram] Briefing callback: ${action}:${id}`);
      } else {
        // Generic callback — just emit
        gateway._emitCallback({ type: 'raw', data, from, message });
        console.log(`[seal:gateway:telegram] Raw callback: ${data}`);
      }
    } catch (err) {
      console.error('[seal:gateway:telegram] Callback handler error:', err.message);

      try {
        await bot.answerCallbackQuery(query.id, { text: 'Error processing action' });
      } catch {}
    }
  });
}

/**
 * Find the label of the pressed button from the inline keyboard in the message.
 */
function _findChoiceLabel(message, callbackData) {
  const keyboard = message?.reply_markup?.inline_keyboard;
  if (!keyboard) return null;

  for (const row of keyboard) {
    for (const btn of row) {
      if (btn.callback_data === callbackData) {
        return btn.text;
      }
    }
  }
  return null;
}
