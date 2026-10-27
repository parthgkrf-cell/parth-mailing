const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'mailing.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Helper for promises
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize schema
async function getSetting(key, fallback = '') {
  const row = await get('SELECT value FROM system_settings WHERE key = ?', [key]);
  if (!row || row.value == null || row.value === '') return fallback;
  return row.value;
}

const initDB = async () => {
  try {
    await run(`PRAGMA foreign_keys = ON`);
    await run(`PRAGMA journal_mode = WAL`);
    await run(`PRAGMA busy_timeout = 5000`);

    // Users table
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user', -- 'master' or 'user'
        is_active INTEGER DEFAULT 1,
        is_approved INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // SMTP Accounts table (Gmail 16-digit app passwords)
    await run(`
      CREATE TABLE IF NOT EXISTS smtp_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        email TEXT NOT NULL,
        app_password TEXT NOT NULL,
        host TEXT DEFAULT 'smtp.gmail.com',
        port INTEGER DEFAULT 465,
        secure INTEGER DEFAULT 1,
        daily_limit INTEGER DEFAULT 450,
        sent_today INTEGER DEFAULT 0,
        last_reset_date TEXT,
        last_sent_at DATETIME,
        is_active INTEGER DEFAULT 1,
        status TEXT DEFAULT 'ready',
        error_message TEXT,
        from_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const smtpCols = await all('PRAGMA table_info(smtp_accounts)');
    if (!smtpCols.some((col) => col.name === 'from_name')) {
      await run('ALTER TABLE smtp_accounts ADD COLUMN from_name TEXT');
    }

    await run(`
      CREATE TABLE IF NOT EXISTS account_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        smtp_account_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, smtp_account_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (smtp_account_id) REFERENCES smtp_accounts(id) ON DELETE CASCADE
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        subject TEXT DEFAULT '',
        cc TEXT DEFAULT '',
        bcc TEXT DEFAULT '',
        body_html TEXT DEFAULT '',
        is_shared INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Drafts table
    await run(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        smtp_account_id INTEGER,
        title TEXT,
        subject TEXT,
        recipients TEXT,
        body_html TEXT,
        body_text TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const draftCols = await all('PRAGMA table_info(drafts)');
    if (!draftCols.some((col) => col.name === 'cc')) {
      await run('ALTER TABLE drafts ADD COLUMN cc TEXT DEFAULT ""');
    }
    if (!draftCols.some((col) => col.name === 'bcc')) {
      await run('ALTER TABLE drafts ADD COLUMN bcc TEXT DEFAULT ""');
    }

    // Scheduled Emails table
    await run(`
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        smtp_account_id INTEGER,
        subject TEXT NOT NULL,
        recipients TEXT NOT NULL, -- comma-separated or JSON list
        total_recipients INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        body_html TEXT NOT NULL,
        body_text TEXT,
        scheduled_for DATETIME NOT NULL,
        status TEXT DEFAULT 'scheduled', -- 'scheduled', 'sending', 'completed', 'paused', 'cancelled', 'failed'
        interval_seconds INTEGER DEFAULT 15, -- Google compliance delay between sends
        random_jitter INTEGER DEFAULT 8,
        templates_json TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const scheduledCols = await all('PRAGMA table_info(scheduled_emails)');
    if (!scheduledCols.some((col) => col.name === 'templates_json')) {
      await run("ALTER TABLE scheduled_emails ADD COLUMN templates_json TEXT DEFAULT '[]'");
    }

    // Email logs table
    await run(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_id INTEGER,
        user_id INTEGER NOT NULL,
        smtp_account_id INTEGER,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL, -- 'sent', 'failed'
        error_message TEXT,
        message_id TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // System Settings table (Master Configuration)
    await run(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT
      )
    `);

    // Default system settings for Gmail compliance & governance
    const defaultSettings = [
      { key: 'app_name', value: 'Parth mailing', description: 'Application Branding Title' },
      { key: 'gmail_max_daily_limit', value: '450', description: 'Maximum emails per Gmail account per 24 hours (Google hard limit is 500 for free Gmail)' },
      { key: 'min_interval_seconds', value: '15', description: 'Minimum delay in seconds between sending emails per account (Spam prevention)' },
      { key: 'default_jitter_seconds', value: '10', description: 'Random jitter up to N seconds to simulate human activity' },
      { key: 'require_user_approval', value: '0', description: 'Whether newly registered users require Master approval before sending' },
      { key: 'enforce_unsubscribe_header', value: '1', description: 'Auto-attach List-Unsubscribe header in accordance with Google 2024+ sender guidelines' },
      { key: 'support_email', value: 'support@parthmailing.local', description: 'Default return/support email address' },
      { key: 'ga4_enabled', value: '1', description: 'Add GA4 UTM tags to website links in outgoing mail' },
      { key: 'ga4_utm_source', value: 'ParthMailing', description: 'GA4 utm_source' },
      { key: 'ga4_utm_medium', value: 'email', description: 'GA4 utm_medium' },
      { key: 'ga4_utm_campaign', value: '101', description: 'GA4 utm_campaign' },
      { key: 'ga4_utm_content', value: '', description: 'GA4 utm_content' },
      { key: 'ga4_sample_url', value: 'https://example.com/cfp.php#section06', description: 'Sample URL used to preview tracked links' },
      { key: 'accounts_sync_enabled', value: '0', description: 'Pull mailbox list from Drive or GitHub' },
      { key: 'accounts_sync_url', value: '', description: 'https Drive or GitHub link to the mailbox JSON' },
      { key: 'accounts_sync_status', value: 'Sync is off.', description: 'Last mailbox sync result' },
      { key: 'accounts_sync_checked_at', value: '', description: 'Last mailbox sync time' },
      { key: 'accounts_revision', value: '0', description: 'Increments when mailboxes change' }
    ];

    for (const s of defaultSettings) {
      await run(`
        INSERT OR IGNORE INTO system_settings (key, value, description)
        VALUES (?, ?, ?)
      `, [s.key, s.value, s.description]);
    }

    // Seed Master Admin account if not present, and keep its email current
    const masterEmail = 'vekariyaparth127@gmail.com';
    const existingMaster = await get(`SELECT id, email FROM users WHERE role = 'master'`);
    if (!existingMaster) {
      const defaultPassword = 'MasterParth@2026';
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(defaultPassword, salt);
      await run(`
        INSERT INTO users (name, email, password_hash, role, is_active, is_approved)
        VALUES (?, ?, ?, 'master', 1, 1)
      `, ['Parth (Master Admin)', masterEmail, hash]);
      console.log(`[Database] Master Admin account created for ${masterEmail}. Change the default password after first login.`);
    } else if (existingMaster.email !== masterEmail) {
      const taken = await get(`SELECT id FROM users WHERE email = ? AND id != ?`, [masterEmail, existingMaster.id]);
      if (taken) {
        console.error(`[Database] Cannot move master login to ${masterEmail}: that email already belongs to another user.`);
      } else {
        await run(`UPDATE users SET email = ? WHERE id = ?`, [masterEmail, existingMaster.id]);
        console.log(`[Database] Master Admin email updated to: ${masterEmail}`);
      }
    }

    console.log('[Database] Tables and initial configuration verified successfully.');
  } catch (err) {
    console.error('[Database] Initialization error:', err);
    throw err;
  }
};

module.exports = {
  db,
  run,
  get,
  all,
  getSetting,
  initDB
};

