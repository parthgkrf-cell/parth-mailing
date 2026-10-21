const express = require('express');
const router = express.Router();
const { get, all, run } = require('../database');
const { requireMaster } = require('../middleware/auth');

// Apply master restriction to all routes in this router
router.use(requireMaster);

// Master Dashboard Analytics & Overview
router.get('/stats', async (req, res) => {
  try {
    const totalUsers = (await get('SELECT COUNT(*) as count FROM users')).count;
    const pendingUsers = (await get('SELECT COUNT(*) as count FROM users WHERE is_approved = 0')).count;
    const totalAccounts = (await get('SELECT COUNT(*) as count FROM smtp_accounts')).count;
    const activeAccounts = (await get('SELECT COUNT(*) as count FROM smtp_accounts WHERE is_active = 1')).count;

    const emailStats = await get(`
      SELECT 
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed
      FROM email_logs
    `);

    const scheduledActive = (await get(`
      SELECT COUNT(*) as count FROM scheduled_emails WHERE status IN ('scheduled', 'sending')
    `)).count;

    // Daily volume across all accounts today
    const sentTodayAll = (await get('SELECT SUM(sent_today) as total FROM smtp_accounts')).total || 0;

    res.json({
      totalUsers,
      pendingUsers,
      totalAccounts,
      activeAccounts,
      totalSent: emailStats.total_sent || 0,
      totalFailed: emailStats.total_failed || 0,
      scheduledActive,
      sentTodayAll
    });
  } catch (err) {
    console.error('Master stats error:', err);
    res.status(500).json({ error: 'Failed to fetch master statistics.' });
  }
});

// User Management: List all users
router.get('/users', async (req, res) => {
  try {
    const users = await all(`
      SELECT 
        u.id, u.name, u.email, u.role, u.is_active, u.is_approved, u.created_at,
        COUNT(DISTINCT a.id) as owned_accounts_count,
        COUNT(DISTINCT aa.smtp_account_id) as assigned_accounts_count,
        COUNT(DISTINCT a.id) as accounts_count,
        COUNT(DISTINCT s.id) as schedules_count,
        COUNT(DISTINCT l.id) as emails_sent_count
      FROM users u
      LEFT JOIN smtp_accounts a ON u.id = a.user_id
      LEFT JOIN account_assignments aa ON u.id = aa.user_id
      LEFT JOIN scheduled_emails s ON u.id = s.user_id
      LEFT JOIN email_logs l ON u.id = l.user_id AND l.status = 'sent'
      GROUP BY u.id
      ORDER BY u.id ASC
    `);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// Toggle user active status
router.put('/users/:id/status', async (req, res) => {
  try {
    const user = await get('SELECT id, role, is_active FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Prevent deactivating own master account
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own master account.' });
    }

    const newStatus = user.is_active === 1 ? 0 : 1;
    await run('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, user.id]);

    res.json({ message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`, is_active: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

// Approve user
router.put('/users/:id/approve', async (req, res) => {
  try {
    await run('UPDATE users SET is_approved = 1 WHERE id = ?', [req.params.id]);
    res.json({ message: 'User approved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve user.' });
  }
});

// Update user role
router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'master'].includes(role)) {
      return res.status(400).json({ error: 'Role must be user or master.' });
    }
    if (Number(req.params.id) === req.user.id && role !== 'master') {
      return res.status(400).json({ error: 'Cannot demote yourself.' });
    }
    await run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'User role updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change role.' });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own master account.' });
    }
    await run('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: 'User and all associated data deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// System Settings: Get all settings
router.get('/settings', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM system_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings, raw: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

// System Settings: Update settings
router.post('/settings', async (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings payload.' });
    }

    for (const [key, value] of Object.entries(settings)) {
      await run(`
        INSERT INTO system_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [key, String(value)]);
    }

    res.json({ message: 'System settings updated successfully!' });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to update system settings.' });
  }
});

// System-wide Accounts overview
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await all(`
      SELECT a.id, a.user_id, a.label, a.email, a.host, a.port, a.secure, a.daily_limit, a.sent_today,
             a.last_reset_date, a.last_sent_at, a.is_active, a.status, a.error_message, a.created_at,
             u.name as owner_name, u.email as owner_email
      FROM smtp_accounts a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.id DESC
    `);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch system accounts.' });
  }
});

// System-wide Global Logs
router.get('/logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const logs = await all(`
      SELECT l.*, u.name as user_name, u.email as user_email, a.email as sender_email
      FROM email_logs l
      JOIN users u ON l.user_id = u.id
      LEFT JOIN smtp_accounts a ON l.smtp_account_id = a.id
      ORDER BY l.sent_at DESC
      LIMIT ?
    `, [limit]);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch global logs.' });
  }
});

router.get('/users/:id/accounts', async (req, res) => {
  try {
    const assigned = await all(
      'SELECT smtp_account_id FROM account_assignments WHERE user_id = ?',
      [req.params.id]
    );
    const accounts = await all('SELECT id, label, email, from_name, is_active FROM smtp_accounts ORDER BY id DESC');
    res.json({
      account_ids: assigned.map((row) => row.smtp_account_id),
      accounts
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch account assignments.' });
  }
});

router.put('/users/:id/accounts', async (req, res) => {
  try {
    const user = await get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const ids = Array.isArray(req.body.account_ids)
      ? [...new Set(req.body.account_ids.map((id) => Number(id)).filter((id) => id > 0))]
      : [];
    await run('DELETE FROM account_assignments WHERE user_id = ?', [user.id]);
    for (const accountId of ids) {
      const account = await get('SELECT id FROM smtp_accounts WHERE id = ?', [accountId]);
      if (!account) continue;
      await run(
        'INSERT OR IGNORE INTO account_assignments (user_id, smtp_account_id) VALUES (?, ?)',
        [user.id, accountId]
      );
    }
    res.json({ message: 'Sending accounts assigned.', account_ids: ids });
  } catch (err) {
    console.error('Assignment error:', err);
    res.status(500).json({ error: 'Failed to assign sending accounts.' });
  }
});

module.exports = router;

