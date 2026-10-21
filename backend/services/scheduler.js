const { get, all, run } = require('../database');
const { sendSingleEmail } = require('./mailer');
const { calculateSafeDelay, checkAndResetDailyQuota } = require('./gmailPolicy');
const {
  parseRecipientPayload,
  applyMerge,
  applyEmailTracking,
  loadGa4Settings,
  resolveSendableAccount
} = require('./campaign');

let isProcessing = false;

function parseRecipients(str) {
  return parseRecipientPayload(str).map((row) => row.email);
}

async function processDueSchedules() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const nowIso = new Date().toISOString();
    const tracking = await loadGa4Settings();
    const dueJobs = await all(`
      SELECT * FROM scheduled_emails
      WHERE status IN ('scheduled', 'sending')
        AND scheduled_for <= ?
      ORDER BY scheduled_for ASC
      LIMIT 3
    `, [nowIso]);

    for (const job of dueJobs) {
      const rows = parseRecipientPayload(job.recipients);
      const processedCount = (job.sent_count || 0) + (job.failed_count || 0);

      if (processedCount >= rows.length) {
        await run(
          'UPDATE scheduled_emails SET status = "completed", completed_at = ? WHERE id = ?',
          [new Date().toISOString(), job.id]
        );
        continue;
      }

      if (job.status === 'scheduled') {
        await run('UPDATE scheduled_emails SET status = "sending" WHERE id = ?', [job.id]);
      }

      const next = rows[processedCount];
      const owner = { id: job.user_id, role: 'user' };
      const templates = await all(
        'SELECT * FROM email_templates WHERE user_id = ? OR is_shared = 1',
        [job.user_id]
      );
      const template = templates.find((item) =>
        String(item.name).toLowerCase() === String((next.template || '')).toLowerCase()
      );
      const mergedSubject = applyMerge(template ? template.subject : job.subject, next);
      const mergedHtml = applyEmailTracking(applyMerge(template ? template.body_html : job.body_html, next), tracking);
      const mergedText = applyMerge(template ? '' : (job.body_text || ''), next);

      let account = await resolveSendableAccount(owner, next.smtp_account_id || job.smtp_account_id, next.sender);
      if (!account && job.smtp_account_id) {
        account = await get('SELECT * FROM smtp_accounts WHERE id = ? AND is_active = 1', [job.smtp_account_id]);
      }
      if (account) checkAndResetDailyQuota(account);

      if (!account) {
        console.warn(`[Scheduler] Job #${job.id}: No available active SMTP account with quota found. Pausing.`);
        await run('UPDATE scheduled_emails SET status = "paused" WHERE id = ?', [job.id]);
        continue;
      }

      try {
        await sendSingleEmail({
          account,
          recipient: next.email,
          subject: mergedSubject,
          bodyHtml: mergedHtml,
          bodyText: mergedText,
          scheduledId: job.id,
          userId: job.user_id,
          fromName: next.sender_name || account.from_name || account.label,
          cc: next.cc || (template && template.cc) || '',
          bcc: next.bcc || (template && template.bcc) || ''
        });

        const newSent = (job.sent_count || 0) + 1;
        const isDone = (newSent + (job.failed_count || 0)) >= rows.length;
        await run(
          `UPDATE scheduled_emails SET sent_count = ?, status = ?, completed_at = ? WHERE id = ?`,
          [newSent, isDone ? 'completed' : 'sending', isDone ? new Date().toISOString() : null, job.id]
        );
        job.sent_count = newSent;
        console.log(`[Scheduler] Sent to ${next.email} via ${account.email} (Schedule #${job.id})`);
      } catch (sendErr) {
        console.error(`[Scheduler] Failed sending to ${next.email}:`, sendErr.message);
        const newFailed = (job.failed_count || 0) + 1;
        const isDone = ((job.sent_count || 0) + newFailed) >= rows.length;
        await run(
          `UPDATE scheduled_emails SET failed_count = ?, status = ?, completed_at = ? WHERE id = ?`,
          [newFailed, isDone ? 'completed' : 'sending', isDone ? new Date().toISOString() : null, job.id]
        );
        job.failed_count = newFailed;
      }

      const delayMs = calculateSafeDelay(job.interval_seconds || 15, job.random_jitter || 8);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
