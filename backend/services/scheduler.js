const { get, all, run, getSetting } = require('../database');
const { sendSingleEmail } = require('./mailer');
const { calculateSafeDelay, checkAndResetDailyQuota } = require('./gmailPolicy');
const {
  parseRecipientPayload,
  applyMerge,
  applyEmailTracking,
  loadGa4Settings,
  resolveSendableAccount,
  findTemplate
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

      const claim = await run(
        `UPDATE scheduled_emails SET status = "sending" WHERE id = ? AND status IN ('scheduled', 'sending')`,
        [job.id]
      );
      if (!claim.changes) continue;

      const next = rows[processedCount];
      const ownerRow = await get('SELECT id, role FROM users WHERE id = ?', [job.user_id]);
      const owner = ownerRow || { id: job.user_id, role: 'user' };
      let clientTemplates = [];
      try {
        if (job.templates_json) {
          const parsed = JSON.parse(job.templates_json);
          if (Array.isArray(parsed)) {
            clientTemplates = parsed.map((t) => ({
              id: t.id,
              name: t.name,
              subject: t.subject,
              body_html: t.rawHtml || t.html || t.body_html || '',
              cc: t.cc,
              bcc: t.bcc
            }));
          }
        }
      } catch (e) {}

      const dbTemplates = await all(
        'SELECT * FROM email_templates WHERE user_id = ? OR is_shared = 1',
        [job.user_id]
      );
      const templates = [...clientTemplates, ...dbTemplates];
      const wantedTemplate = String(next.template || '').trim();
      const template = wantedTemplate.includes('<') && wantedTemplate.includes('>')
        ? { name: 'Inline HTML', body_html: wantedTemplate, subject: '' }
        : findTemplate(templates, wantedTemplate);
      const mergedSubject = applyMerge((template && template.subject) ? template.subject : job.subject, next);
      const mergedHtml = applyEmailTracking(applyMerge((template && template.body_html) ? template.body_html : job.body_html, next), tracking);
      const mergedText = applyMerge(template ? '' : (job.body_text || ''), next);

      const account = await resolveSendableAccount(owner, next.smtp_account_id || job.smtp_account_id, next.sender);
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
        const msg = sendErr.message || '';
        console.error(`[Scheduler] Failed sending to ${next.email}:`, msg);
        const blocking = /daily limit|quota|authentication|username and password|not active/i.test(msg);
        if (blocking) {
          await run('UPDATE scheduled_emails SET status = "paused" WHERE id = ?', [job.id]);
          console.warn(`[Scheduler] Job #${job.id} paused so the rest of the list is not failed one by one.`);
          continue;
        }
        const newFailed = (job.failed_count || 0) + 1;
        const isDone = ((job.sent_count || 0) + newFailed) >= rows.length;
        await run(
          `UPDATE scheduled_emails SET failed_count = ?, status = ?, completed_at = ? WHERE id = ?`,
          [newFailed, isDone ? 'completed' : 'sending', isDone ? new Date().toISOString() : null, job.id]
        );
        job.failed_count = newFailed;
      }

      const minInterval = Math.min(120, Math.max(5, Number(await getSetting('min_interval_seconds', '15')) || 15));
      const delayMs = calculateSafeDelay(
        Math.max(Number(job.interval_seconds) || minInterval, minInterval),
        Number(job.random_jitter) || 0
      );
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
