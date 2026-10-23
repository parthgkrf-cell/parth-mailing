const express = require('express');
const router = express.Router();
const { get, all, run, getSetting } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { verifyAccountConnection, cleanPassword } = require('../services/mailer');
const { checkAndResetDailyQuota } = require('../services/gmailPolicy');
const { listSendableAccounts } = require('../services/campaign');
const { bumpRevision, getAccountFeed } = require('../services/accountSync');

// Helper to mask 16 digit app password
function maskPassword(pass) {
  if (!pass) return '';
  const clean = cleanPassword(pass);
  if (clean.length < 4) return '****';
  return '**** **** **** ' + clean.slice(-4);
}

// List user's accounts
router.get('/', requireAuth, async (req, res) => {
  try {
    const isMaster = req.user.role === 'master';
    let rows;
    if (isMaster && req.query.all === 'true') {
      rows = await all(`
        SELECT a.*, u.name as user_name FROM smtp_accounts a
        LEFT JOIN users u ON a.user_id = u.id
        ORDER BY a.id DESC
      `);
    } else if (isMaster) {
      rows = await all('SELECT * FROM smtp_accounts ORDER BY id DESC');
    } else {
      rows = await listSendableAccounts(req.user);
    }

    // Check daily quotas for each
    for (const r of rows) {
      if (checkAndResetDailyQuota(r)) {
        await run('UPDATE smtp_accounts SET sent_today = 0, last_reset_date = ? WHERE id = ?', [r.last_reset_date, r.id]);
      }
      r.masked_password = maskPassword(r.app_password);
      delete r.app_password; // never send raw password to client
    }

    const feed = await getAccountFeed();
    res.json({ accounts: rows, ...feed });
  } catch (err) {
    console.error('Error fetching accounts:', err);
    res.status(500).json({ error: 'Failed to fetch SMTP accounts.' });
  }
});

// Add new Gmail / SMTP account
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'master') {
      return res.status(403).json({ error: 'Only Master Admin can add sending accounts. Ask admin to assign an account to you.' });
    }
    const { label, email, app_password, host = 'smtp.gmail.com', port = 465, secure = 1, daily_limit = 450, from_name } = req.body;

    if (!label || !email || !app_password) {
      return res.status(400).json({ error: 'Label, Gmail Email address, and 16-digit App Password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanPass = cleanPassword(app_password);

    if (cleanPass.length < 8) {
      return res.status(400).json({ error: 'Google App Passwords are 16 characters long. Please check your passcode.' });
    }

    const globalCap = Math.min(500, Math.max(50, Number(await getSetting('gmail_max_daily_limit', '450')) || 450));
    const safeDailyLimit = Math.min(Math.max(10, Number(daily_limit) || globalCap), globalCap);

    // Perform live connection test first
    const testAccount = {
      label,
      email: cleanEmail,
      app_password: cleanPass,
      host,
      port: Number(port),
      secure: Number(secure)
    };

    const testResult = await verifyAccountConnection(testAccount);
    if (!testResult.success) {
      return res.status(400).json({
        error: `SMTP connection failed: ${testResult.error}`,
        hint: 'Please ensure 2-Step Verification is turned ON in your Google Account and generate an App Password from https://myaccount.google.com/apppasswords'
      });
    }

    const today = new Date().toISOString().split('T')[0];
    const result = await run(
      `INSERT INTO smtp_accounts (user_id, label, email, app_password, host, port, secure, daily_limit, sent_today, last_reset_date, is_active, status, from_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, 'ready', ?)`,
      [req.user.id, label.trim(), cleanEmail, cleanPass, host, Number(port), Number(secure), safeDailyLimit, today, from_name || label.trim()]
    );

    await bumpRevision();
    res.status(201).json({
      message: 'Gmail account connected and verified successfully!',
      accountId: result.lastID
    });
  } catch (err) {
    console.error('Error adding account:', err);
    res.status(500).json({ error: 'Failed to add SMTP account.' });
  }
});

// Test connection of existing account
router.post('/:id/test', requireAuth, async (req, res) => {
  try {
    const account = await get('SELECT * FROM smtp_accounts WHERE id = ?', [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    if (account.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const result = await verifyAccountConnection(account);
    if (result.success) {
      await run('UPDATE smtp_accounts SET status = "ready", error_message = NULL WHERE id = ?', [account.id]);
      res.json({ success: true, message: 'Google SMTP authentication verified successfully!' });
    } else {
      await run('UPDATE smtp_accounts SET status = "error", error_message = ? WHERE id = ?', [result.error, account.id]);
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to test connection.' });
  }
});

// Toggle active or update settings
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const account = await get('SELECT * FROM smtp_accounts WHERE id = ?', [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    if (account.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const { label, is_active, daily_limit, app_password, from_name } = req.body;
    let newPass = account.app_password;
    if (app_password && app_password.trim() && !app_password.includes('****')) {
      newPass = cleanPassword(app_password);
    }

    const globalCap = Math.min(500, Math.max(50, Number(await getSetting('gmail_max_daily_limit', '450')) || 450));
    const newLimit = daily_limit !== undefined ? Math.min(Math.max(10, Number(daily_limit)), globalCap) : account.daily_limit;
    const newActive = is_active !== undefined ? (is_active ? 1 : 0) : account.is_active;
    const newLabel = label !== undefined ? label.trim() : account.label;
    const newFrom = from_name !== undefined ? String(from_name).trim() : account.from_name;

    await run(
      'UPDATE smtp_accounts SET label = ?, is_active = ?, daily_limit = ?, app_password = ?, from_name = ? WHERE id = ?',
      [newLabel, newActive, newLimit, newPass, newFrom, account.id]
    );

    await bumpRevision();
    res.json({ message: 'Account updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update account.' });
  }
});

// Reset daily counter
router.post('/:id/reset-quota', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'master') {
      return res.status(403).json({ error: 'Only Master Admin can reset a daily sending quota.' });
    }
    const account = await get('SELECT * FROM smtp_accounts WHERE id = ?', [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    if (account.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const today = new Date().toISOString().split('T')[0];
    await run('UPDATE smtp_accounts SET sent_today = 0, last_reset_date = ?, status = "ready", error_message = NULL WHERE id = ?', [today, account.id]);

    await bumpRevision();
    res.json({ message: 'Daily quota reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset quota.' });
  }
});

// Delete account
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const account = await get('SELECT * FROM smtp_accounts WHERE id = ?', [req.params.id]);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    if (account.user_id !== req.user.id && req.user.role !== 'master') {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    await run('DELETE FROM smtp_accounts WHERE id = ?', [account.id]);
    await bumpRevision();
    res.json({ message: 'Account deleted successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

module.exports = router;

