const { get, all, run } = require('../database');
const { sendSingleEmail } = require('./mailer');
const { calculateSafeDelay, checkAndResetDailyQuota } = require('./gmailPolicy');

let isProcessing = false;

/**
 * Parses recipients string (supports comma, newline, or JSON array format)
 */
function parseRecipients(str) {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) return parsed.map(s => String(s).trim()).filter(Boolean);
  } catch (e) {
    // not json
  }
  return str
    .split(/[\r\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.includes('@'));
}

/**
 * Main Scheduler loop step
 */
async function processDueSchedules() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const nowIso = new Date().toISOString();

    // Query pending or currently sending schedules that are due
    const dueJobs = await all(`
      SELECT * FROM scheduled_emails
      WHERE status IN ('scheduled', 'sending')
        AND scheduled_for <= ?
      ORDER BY scheduled_for ASC
      LIMIT 3
    `, [nowIso]);

    for (const job of dueJobs) {
      const allRecipients = parseRecipients(job.recipients);
      const processedCount = (job.sent_count || 0) + (job.failed_count || 0);

      if (processedCount >= allRecipients.length) {
        // Job is finished
        await run(
          'UPDATE scheduled_emails SET status = "completed", completed_at = ? WHERE id = ?',
          [new Date().toISOString(), job.id]
        );
        continue;
      }

      // Mark job as in-progress if it was 'scheduled'
      if (job.status === 'scheduled') {
        await run('UPDATE scheduled_emails SET status = "sending" WHERE id = ?', [job.id]);
      }

      // Find an available active SMTP account
      let account = null;
      if (job.smtp_account_id) {
        account = await get('SELECT * FROM smtp_accounts WHERE id = ? AND is_active = 1', [job.smtp_account_id]);
      } else {
        // Auto-rotation across user's active accounts with remaining daily quota
        const userAccounts = await all(
          'SELECT * FROM smtp_accounts WHERE user_id = ? AND is_active = 1 ORDER BY sent_today ASC',
          [job.user_id]
        );
        for (const acc of userAccounts) {
          checkAndResetDailyQuota(acc);
          if (acc.sent_today < (acc.daily_limit || 450) && acc.status !== 'error') {
            account = acc;
            break;
          }
        }
      }

      if (!account) {
        console.warn(`[Scheduler] Job #${job.id}: No available active SMTP account with quota found. Pausing.`);
        await run('UPDATE scheduled_emails SET status = "paused" WHERE id = ?', [job.id]);
        continue;
      }

      // Pick next recipient
      const nextRecipient = allRecipients[processedCount];

      try {
        await sendSingleEmail({
          account,
          recipient: nextRecipient,
          subject: job.subject,
          bodyHtml: job.body_html,
          bodyText: job.body_text,
          scheduledId: job.id,
          userId: job.user_id
        });

        const newSent = (job.sent_count || 0) + 1;
        const isDone = (newSent + (job.failed_count || 0)) >= allRecipients.length;

        await run(
          `UPDATE scheduled_emails
           SET sent_count = ?, status = ?, completed_at = ?
           WHERE id = ?`,
          [newSent, isDone ? 'completed' : 'sending', isDone ? new Date().toISOString() : null, job.id]
        );

        console.log(`[Scheduler] Sent to ${nextRecipient} via ${account.email} (Schedule #${job.id})`);
      } catch (sendErr) {
        console.error(`[Scheduler] Failed sending to ${nextRecipient}:`, sendErr.message);

        const newFailed = (job.failed_count || 0) + 1;
        const isDone = ((job.sent_count || 0) + newFailed) >= allRecipients.length;

        await run(
          `UPDATE scheduled_emails
           SET failed_count = ?, status = ?, completed_at = ?
           WHERE id = ?`,
          [newFailed, isDone ? 'completed' : 'sending', isDone ? new Date().toISOString() : null, job.id]
        );
      }

      // Google Policy compliance: Pacing delay before processing next recipient
      const delayMs = calculateSafeDelay(job.interval_seconds || 15, job.random_jitter || 8);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  } catch (err) {
    console.error('[Scheduler] Error during execution cycle:', err);
  } finally {
    isProcessing = false;
  }
}

function startScheduler() {
  console.log('[Scheduler] Email Scheduling & Compliance worker started (interval: 5s)...');
  setInterval(processDueSchedules, 5000);
}

module.exports = {
  startScheduler,
  parseRecipients
};

