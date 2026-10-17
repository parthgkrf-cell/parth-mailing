const express = require('express');
const router = express.Router();
const { get, all, run } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { validateGmailCompliance } = require('../services/gmailPolicy');
const { sendSingleEmail } = require('../services/mailer');
const { parseRecipients } = require('../services/scheduler');

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

    const recipientList = parseRecipients(recipients);
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
        JSON.stringify(recipientList),
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

    const recipientList = parseRecipients(recipients);
    const compliance = validateGmailCompliance({
      subject,
      body_html,
      body_text,
      recipients: recipientList
    });

    if (!compliance.isValid) {
      return res.status(400).json({ error: compliance.issues.join(' ') });
    }

    // Determine account
    let account = null;
    if (smtp_account_id) {
      account = await get('SELECT * FROM smtp_accounts WHERE id = ? AND user_id = ? AND is_active = 1', [smtp_account_id, req.user.id]);
    } else {
      account = await get('SELECT * FROM smtp_accounts WHERE user_id = ? AND is_active = 1 AND sent_today < daily_limit ORDER BY sent_today ASC LIMIT 1', [req.user.id]);
    }

    if (!account) {
      return res.status(400).json({ error: 'No active Google/SMTP account available or daily quota exceeded.' });
    }

    if (recipientList.length > 10) {
      // If mass recipients, recommend schedule to enforce Google compliant pacing
      return res.status(400).json({
        error: 'To protect your Gmail account from being flagged by Google spam filters, blasts of more than 10 recipients must use the "Schedule / Queue" option so safe pacing and intervals are maintained.'
      });
    }

    // Send immediately to first recipient or few
    const results = [];
    for (const recipient of recipientList) {
      const resItem = await sendSingleEmail({
        account,
        recipient,
        subject,
        bodyHtml: body_html,
        bodyText: body_text,
        userId: req.user.id
      });
      results.push({ recipient, ...resItem });
    }

    res.json({
      message: `Successfully sent ${results.length} email(s) via ${account.email}!`,
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

