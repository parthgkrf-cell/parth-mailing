const { get, all, run, getSetting } = require('../database');
const { cleanPassword } = require('./mailer');

const ALLOWED_HOSTS = ['drive.google.com', 'docs.google.com', 'raw.githubusercontent.com', 'github.com'];

function normalizeSyncUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error('Sync link must be a full https URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Sync link must start with https://.');
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.includes(host) || host.endsWith('.githubusercontent.com');
  if (!allowed) {
    throw new Error('Use a Google Drive file link or a GitHub link. Other sites are refused.');
  }

  const fileId = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (fileId) return `https://drive.google.com/uc?export=download&id=${fileId[1]}`;
  if (host === 'drive.google.com' && parsed.searchParams.get('id')) {
    return `https://drive.google.com/uc?export=download&id=${parsed.searchParams.get('id')}`;
  }
  if (host === 'github.com' && url.includes('/blob/')) {
    return url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/');
  }
  return url;
}

function publicGithubWarning(url) {
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch (err) { return ''; }
  })();
  if (host === 'raw.githubusercontent.com' || host === 'github.com' || host.endsWith('.githubusercontent.com')) {
    return 'This GitHub link can be read by anyone who can open it. Do not put mailbox passwords in a public repository.';
  }
  return '';
}

async function bumpRevision() {
  const current = Number(await getSetting('accounts_revision', '0')) || 0;
  const next = String(current + 1);
  await run(
    `INSERT INTO system_settings (key, value, description) VALUES ('accounts_revision', ?, 'Mailbox list revision')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [next]
  );
  return Number(next);
}

async function getAccountFeed() {
  return {
    revision: Number(await getSetting('accounts_revision', '0')) || 0,
    sync_enabled: (await getSetting('accounts_sync_enabled', '0')) === '1',
    sync_status: await getSetting('accounts_sync_status', 'Sync is off.'),
    sync_checked_at: await getSetting('accounts_sync_checked_at', '')
  };
}

async function writeSyncStatus(message) {
  const now = new Date().toISOString();
  const pairs = [
    ['accounts_sync_status', String(message || '').slice(0, 500)],
    ['accounts_sync_checked_at', now]
  ];
  for (const [key, value] of pairs) {
    await run(
      `INSERT INTO system_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }
}

async function applyAccountSnapshot(payload) {
  const body = payload && !Array.isArray(payload) ? payload : { accounts: payload };
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  if (!accounts.length) {
    throw new Error('Sync file has no accounts. No mailboxes were changed.');
  }

  const master = await get(`SELECT id FROM users WHERE role = 'master' ORDER BY id ASC`);
  if (!master) throw new Error('No Super Admin account exists to own synced mailboxes.');

  const authoritative = body.authoritative !== false;
  const seen = new Set();
  const notes = [];
  let changed = 0;

  for (const item of accounts) {
    const email = String(item.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notes.push(`Skipped a row with an invalid email.`);
      continue;
    }
    seen.add(email);
    const existing = await get('SELECT * FROM smtp_accounts WHERE lower(email) = ?', [email]);
    const password = cleanPassword(item.app_password || item.password || '');
    const label = String(item.label || item.from_name || email).trim().slice(0, 120);
    const fromName = String(item.from_name || item.label || '').trim().slice(0, 120);
    const host = String(item.host || 'smtp.gmail.com').trim().slice(0, 120);
    const port = Number(item.port) === 587 ? 587 : 465;
    const secure = port === 465 ? 1 : 0;
    const dailyLimit = Math.min(500, Math.max(10, Number(item.daily_limit) || 450));
    const active = item.is_active === false || item.is_active === 0 || item.is_active === '0' ? 0 : 1;

    if (!existing && password.length < 8) {
      notes.push(`${email} was not added because the sync file has no app password.`);
      continue;
    }
    if (existing && password && password.length < 8 && !password.includes('*')) {
      notes.push(`${email} kept its saved password because the new one is too short.`);
    }

    let accountId;
    if (!existing) {
      const today = new Date().toISOString().split('T')[0];
      const inserted = await run(
        `INSERT INTO smtp_accounts (user_id, label, email, app_password, host, port, secure, daily_limit, sent_today, last_reset_date, is_active, status, from_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'ready', ?)`,
        [master.id, label, email, password, host, port, secure, dailyLimit, today, active, fromName || label]
      );
      accountId = inserted.lastID;
      changed += 1;
    } else {
      const nextPassword = password.length >= 8 ? password : existing.app_password;
      await run(
        `UPDATE smtp_accounts
         SET label = ?, from_name = ?, host = ?, port = ?, secure = ?, daily_limit = ?, is_active = ?, app_password = ?
         WHERE id = ?`,
        [label, fromName || existing.from_name, host, port, secure, dailyLimit, active, nextPassword, existing.id]
      );
      accountId = existing.id;
      changed += 1;
    }

    if (Array.isArray(item.assigned_to)) {
      await run('DELETE FROM account_assignments WHERE smtp_account_id = ?', [accountId]);
      for (const who of item.assigned_to) {
        const userEmail = String(who || '').trim().toLowerCase();
        const user = await get(`SELECT id FROM users WHERE email = ?`, [userEmail]);
        if (!user) {
          notes.push(`${email} could not be assigned to ${userEmail || 'a blank user'} because that person is not registered.`);
          continue;
        }
        await run(
          'INSERT OR IGNORE INTO account_assignments (user_id, smtp_account_id) VALUES (?, ?)',
          [user.id, accountId]
        );
      }
    }
  }

  let switchedOff = 0;
  if (authoritative) {
    const rows = await all('SELECT id, email FROM smtp_accounts');
    for (const row of rows) {
      if (seen.has(String(row.email).toLowerCase())) continue;
      await run('UPDATE smtp_accounts SET is_active = 0 WHERE id = ?', [row.id]);
      switchedOff += 1;
    }
  }

  const revision = await bumpRevision();
  const summary = `Updated ${changed} mailbox(es).${switchedOff ? ` Switched off ${switchedOff} mailbox(es) that are not in the file.` : ''}${notes.length ? ` ${notes.join(' ')}` : ''}`;
  return { revision, changed, switchedOff, notes, summary: summary.trim() };
}

async function fetchAccountSnapshot(url) {
  const downloadUrl = normalizeSyncUrl(url);
  const response = await fetch(downloadUrl, {
    headers: { Accept: 'application/json, text/plain;q=0.9' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`Sync link returned ${response.status}. Check that the Drive file or GitHub file is shared.`);
  }
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Error('Sync link did not return JSON. For Drive, share the file as "Anyone with the link". For GitHub, use the raw file link.');
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error('Sync file is not valid JSON.');
  }
}

let syncing = false;

async function syncAccountsOnce() {
  if (syncing) return { skipped: true };
  const enabled = (await getSetting('accounts_sync_enabled', '0')) === '1';
  const url = await getSetting('accounts_sync_url', '');
  if (!enabled || !url) {
    return { skipped: true };
  }
  syncing = true;
  try {
    const payload = await fetchAccountSnapshot(url);
    const applied = await applyAccountSnapshot(payload);
    const warning = publicGithubWarning(url);
    const message = warning ? `${applied.summary} ${warning}` : applied.summary;
    await writeSyncStatus(message);
    return { ok: true, ...applied, warning };
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'Sync link timed out after 20 seconds.' : (err.message || 'Sync failed.');
    await writeSyncStatus(message);
    return { ok: false, error: message };
  } finally {
    syncing = false;
  }
}

function startAccountSync() {
  console.log('[Accounts] Mailbox sync worker started (interval: 10s)...');
  setInterval(() => {
    syncAccountsOnce().catch((err) => console.error('[Accounts] Sync error:', err.message));
  }, 10000);
}

module.exports = {
  normalizeSyncUrl,
  publicGithubWarning,
  bumpRevision,
  getAccountFeed,
  applyAccountSnapshot,
  fetchAccountSnapshot,
  syncAccountsOnce,
  startAccountSync
};
