const express = require('express');
const router = express.Router();
const { get, all, run } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { validateGmailCompliance } = require('../services/gmailPolicy');
const { sendSingleEmail } = require('../services/mailer');
const { parseRecipients } = require('../services/scheduler');
const {
  parseRecipientPayload,
  applyMerge,
  applyEmailTracking,
  loadGa4Settings,
  tagUrlForGa4,
  resolveSendableAccount
} = require('../services/campaign');

// Check compliance & Spam score preview
router.post('/check-compliance', requireAuth, (req, res) => {
  const { subject, body_html, body_text, recipients } = req.body;
  const parsed = parseRecipients(recipients);
  const result = validateGmailCompliance({
    subject,
    body_html,
    body_text,
    recipients: parsed
  });
  res.json({ ...result, recipientCount: parsed.length });
});

// User overview statistics
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Accounts
    const accounts = await all('SELECT sent_today, daily_limit FROM smtp_accounts WHERE user_id = ? AND is_active = 1', [userId]);
    const totalSentToday = accounts.reduce((acc, cur) => acc + (cur.sent_today || 0), 0);
    const totalDailyQuota = accounts.reduce((acc, cur) => acc + (cur.daily_limit || 450), 0);

    // Drafts
    const draftsCount = (await get('SELECT COUNT(*) as count FROM drafts WHERE user_id = ?', [userId])).count;

    // Scheduled queues
    const scheduledCount = (await get(`
      SELECT COUNT(*) as count FROM scheduled_emails 
      WHERE user_id = ? AND status IN ('scheduled', 'sending')
    `, [userId])).count;

    // Total sent & failed logs
    const logsStats = await get(`
      SELECT 
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed
      FROM email_logs WHERE user_id = ?
    `, [userId]);

    res.json({
      totalSentToday,
      totalDailyQuota,
      activeAccountsCount: accounts.length,
      draftsCount,
      scheduledCount,
      totalSent: logsStats.total_sent || 0,
      totalFailed: logsStats.total_failed || 0
    });
  } catch (err) {
    console.error('Error getting stats:', err);
    res.status(500).json({ error: 'Failed to fetch email statistics.' });
  }
});

async function listVisibleTemplates(user) {
  if (user.role === 'master') {
    return all('SELECT * FROM email_templates ORDER BY name COLLATE NOCASE');
  }
  return all(
    `SELECT * FROM email_templates
     WHERE user_id = ? OR is_shared = 1
     ORDER BY name COLLATE NOCASE`,
    [user.id]
  );
}

router.get('/templates', requireAuth, async (req, res) => {
  try {
    const templates = await listVisibleTemplates(req.user);
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates.' });
  }
});

router.post('/templates', requireAuth, async (req, res) => {
  try {
    const { name, subject, cc, bcc, body_html } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Template name is required.' });
    }
    const result = await run(
      `INSERT INTO email_templates (user_id, name, subject, cc, bcc, body_html, is_shared, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        String(name).trim(),
        subject || '',
        cc || '',
        bcc || '',
        body_html || '',
        req.user.role === 'master' ? 1 : 0,
        new Date().toISOString()
      ]
    );
    const template = await get('SELECT * FROM email_templates WHERE id = ?', [result.lastID]);
    res.status(201).json({ message: 'Template saved.', template });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template.' });
  }
});

router.put('/templates/:id', requireAuth, async (req, res) => {
  try {
    const template = await get('SELECT * FROM email_templates WHERE id = ?', [req.params.id]);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    if (template.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'You can only edit your own templates.' });
    }
    const { name, subject, cc, bcc, body_html } = req.body;
    await run(
      `UPDATE email_templates
       SET name = ?, subject = ?, cc = ?, bcc = ?, body_html = ?, updated_at = ?
       WHERE id = ?`,
      [
        name != null ? String(name).trim() : template.name,
        subject != null ? subject : template.subject,
        cc != null ? cc : template.cc,
        bcc != null ? bcc : template.bcc,
        body_html != null ? body_html : template.body_html,
        new Date().toISOString(),
        template.id
      ]
    );
    const updated = await get('SELECT * FROM email_templates WHERE id = ?', [template.id]);
    res.json({ message: 'Template updated.', template: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

router.delete('/templates/:id', requireAuth, async (req, res) => {
  try {
    const template = await get('SELECT * FROM email_templates WHERE id = ?', [req.params.id]);
    if (!template) return res.status(404).json({ error: 'Template not found.' });
    if (template.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'You can only delete your own templates.' });
    }
    await run('DELETE FROM email_templates WHERE id = ?', [template.id]);
    res.json({ message: 'Template deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template.' });
  }
});

router.get('/ga4', requireAuth, async (req, res) => {
  try {
    const tracking = await loadGa4Settings();
    res.json({
      tracking,
      preview: tagUrlForGa4(tracking.sampleUrl, tracking)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load GA4 settings.' });
  }
});

router.post('/ga4', requireAuth, async (req, res) => {
  try {
    const incoming = req.body.tracking || req.body;
    const tracking = {
      enabled: incoming.enabled !== false && incoming.enabled !== '0',
      source: String(incoming.source || 'ParthMailing').trim() || 'ParthMailing',
      medium: String(incoming.medium || 'email').trim() || 'email',
      campaign: incoming.campaign == null ? '101' : String(incoming.campaign).trim(),
      content: String(incoming.content || '').trim(),
      sampleUrl: String(incoming.sampleUrl || incoming.sample_url || 'https://example.com/cfp.php#section06').trim()
    };
    const pairs = [
      ['ga4_enabled', tracking.enabled ? '1' : '0'],
      ['ga4_utm_source', tracking.source],
      ['ga4_utm_medium', tracking.medium],
      ['ga4_utm_campaign', tracking.campaign],
      ['ga4_utm_content', tracking.content],
      ['ga4_sample_url', tracking.sampleUrl]
    ];
    for (const [key, value] of pairs) {
      await run(
        `INSERT INTO system_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
      );
    }
    res.json({
      message: 'GA4 tracker saved.',
      tracking,
      preview: tagUrlForGa4(tracking.sampleUrl, tracking)
    });
  } catch (err) {
    console.error('GA4 save error:', err);
    res.status(500).json({ error: 'Failed to save GA4 settings.' });
  }
});

router.post('/preview-merge', requireAuth, async (req, res) => {
  try {
    const tracking = await loadGa4Settings();
    const rec = parseRecipientPayload([req.body.recipient || req.body]).pop() || {};
    const subject = applyMerge(req.body.subject || '', rec);
    const html = applyEmailTracking(applyMerge(req.body.body_html || '', rec), tracking);
    res.json({
      subject,
      html,
      from_name: rec.sender_name || rec.from_name || '',
      sender: rec.sender || '',
      preview_link: tagUrlForGa4(tracking.sampleUrl, tracking)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build preview.' });
  }
});

// --- DRAFTS ---

router.get('/drafts', requireAuth, async (req, res) => {
  try {
    const drafts = await all('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]);
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch drafts.' });
  }
});

router.post('/drafts', requireAuth, async (req, res) => {
  try {
    const { title, subject, recipients, body_html, body_text, smtp_account_id } = req.body;
    const result = await run(
      `INSERT INTO drafts (user_id, smtp_account_id, title, subject, recipients, body_html, body_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        smtp_account_id || null,
        title || 'Untitled Draft',
        subject || '',
        recipients || '',
        body_html || '',
        body_text || '',
        new Date().toISOString()
      ]
    );
    res.status(201).json({ message: 'Draft saved successfully!', draftId: result.lastID });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save draft.' });
  }
});

router.put('/drafts/:id', requireAuth, async (req, res) => {
  try {
    const draft = await get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found.' });

    const { title, subject, recipients, body_html, body_text, smtp_account_id } = req.body;
    await run(
      `UPDATE drafts
       SET title = ?, subject = ?, recipients = ?, body_html = ?, body_text = ?, smtp_account_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        title || draft.title,
        subject !== undefined ? subject : draft.subject,
        recipients !== undefined ? recipients : draft.recipients,
        body_html !== undefined ? body_html : draft.body_html,
        body_text !== undefined ? body_text : draft.body_text,
        smtp_account_id !== undefined ? smtp_account_id : draft.smtp_account_id,
        new Date().toISOString(),
        draft.id
      ]
    );
    res.json({ message: 'Draft updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update draft.' });
  }
});

router.delete('/drafts/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM drafts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Draft deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete draft.' });
  }
});

// --- SCHEDULES ---

router.get('/schedules', requireAuth, async (req, res) => {
  try {
    const schedules = await all(`
      SELECT s.*, a.email as account_email, a.label as account_label
      FROM scheduled_emails s
      LEFT JOIN smtp_accounts a ON s.smtp_account_id = a.id
      WHERE s.user_id = ?
      ORDER BY s.id DESC
    `, [req.user.id]);
    res.json({ schedules });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch schedules.' });
  }
});

router.post('/schedules', requireAuth, async (req, res) => {
  try {
    const { subject, recipients, body_html, body_text, scheduled_for, smtp_account_id, interval_seconds = 15, random_jitter = 8 } = req.body;

    const recipientRows = parseRecipientPayload(recipients);
    const recipientList = recipientRows.map((row) => row.email);
    const compliance = validateGmailCompliance({
      subject,
      body_html,
      body_text,
      recipients: recipientList
    });

    if (!compliance.isValid) {
      return res.status(400).json({ error: compliance.issues.join(' ') });
    }

    if (!scheduled_for) {
      return res.status(400).json({ error: 'Scheduled time is required.' });
    }

    const scheduledDate = new Date(scheduled_for);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: 'Invalid scheduled date/time.' });
    }

    // Google compliance: Enforce safe interval (minimum 10 seconds)
    const safeInterval = Math.max(10, Number(interval_seconds) || 15);
    const safeJitter = Math.max(2, Number(random_jitter) || 8);

    const result = await run(
      `INSERT INTO scheduled_emails (
        user_id, smtp_account_id, subject, recipients, total_recipients, sent_count, failed_count,
        body_html, body_text, scheduled_for, status, interval_seconds, random_jitter, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'scheduled', ?, ?, ?)`,
      [
        req.user.id,
        smtp_account_id || null,
        subject.trim(),
        JSON.stringify(recipientRows.length ? recipientRows : recipientList),
        recipientList.length,
        body_html,
        body_text || '',
        scheduledDate.toISOString(),
        safeInterval,
        safeJitter,
        new Date().toISOString()
      ]
    );

    res.status(201).json({
      message: `Successfully scheduled email campaign for ${recipientList.length} recipient(s)!`,
      scheduleId: result.lastID,
      complianceScore: compliance.spamRiskScore
    });
  } catch (err) {
    console.error('Error creating schedule:', err);
    res.status(500).json({ error: 'Failed to schedule emails.' });
  }
});

// Pause / Resume / Cancel Schedule
router.put('/schedules/:id/pause', requireAuth, async (req, res) => {
  try {
    await run('UPDATE scheduled_emails SET status = "paused" WHERE id = ? AND user_id = ? AND status IN ("scheduled", "sending")', [req.params.id, req.user.id]);
    res.json({ message: 'Schedule paused.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause schedule.' });
  }
});

router.put('/schedules/:id/resume', requireAuth, async (req, res) => {
  try {
    await run('UPDATE scheduled_emails SET status = "scheduled" WHERE id = ? AND user_id = ? AND status = "paused"', [req.params.id, req.user.id]);
    res.json({ message: 'Schedule resumed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resume schedule.' });
  }
});

router.delete('/schedules/:id', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM scheduled_emails WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ message: 'Schedule deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete schedule.' });
  }
});

// Instant Send Now
router.post('/send-now', requireAuth, async (req, res) => {
  try {
    const { subject, recipients, body_html, body_text, smtp_account_id } = req.body;

    const recipientRows = parseRecipientPayload(recipients);
    const recipientList = recipientRows.map((row) => row.email);
    const compliance = validateGmailCompliance({
      subject,
      body_html,
      body_text,
      recipients: recipientList
    });

    if (!compliance.isValid) {
      return res.status(400).json({ error: compliance.issues.join(' ') });
    }

    if (recipientList.length > 10) {
      return res.status(400).json({
        error: 'To protect your Gmail account from being flagged by Google spam filters, blasts of more than 10 recipients must use the "Schedule / Queue" option so safe pacing and intervals are maintained.'
      });
    }

    const tracking = await loadGa4Settings();
    const templates = await listVisibleTemplates(req.user);
    const results = [];
    let lastAccount = null;
    for (const row of recipientRows) {
      const template = templates.find((item) =>
        String(item.name).toLowerCase() === String(row.template || '').toLowerCase()
      );
      const mergedSubject = applyMerge(template ? template.subject : subject, row);
      const mergedHtml = applyEmailTracking(applyMerge(template ? template.body_html : body_html, row), tracking);
      const mergedText = applyMerge(template ? (template.body_html || '').replace(/<[^>]*>?/gm, ' ') : (body_text || ''), row);
      const account = await resolveSendableAccount(req.user, row.smtp_account_id || smtp_account_id, row.sender);
      if (!account) {
        return res.status(400).json({ error: 'No sending account assigned. Ask Master Admin to give you a mailbox.' });
      }
      lastAccount = account;
      const resItem = await sendSingleEmail({
        account,
        recipient: row.email,
        subject: mergedSubject,
        bodyHtml: mergedHtml,
        bodyText: mergedText,
        userId: req.user.id,
        fromName: row.sender_name || account.from_name || account.label,
        cc: row.cc || (template && template.cc) || '',
        bcc: row.bcc || (template && template.bcc) || ''
      });
      results.push({ recipient: row.email, ...resItem });
    }

    res.json({
      message: `Successfully sent ${results.length} email(s)${lastAccount ? ` via ${lastAccount.email}` : ''}!`,
      results
    });
  } catch (err) {
    console.error('Send now error:', err);
    res.status(500).json({ error: err.message || 'Failed to send email.' });
  }
});

// History Logs
router.get('/logs', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const logs = await all(`
      SELECT l.*, a.email as sender_email, a.label as account_label
      FROM email_logs l
      LEFT JOIN smtp_accounts a ON l.smtp_account_id = a.id
      WHERE l.user_id = ?
      ORDER BY l.sent_at DESC
      LIMIT ?
    `, [req.user.id, limit]);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch email logs.' });
  }
});

module.exports = router;

