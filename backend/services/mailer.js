const nodemailer = require('nodemailer');
const { run, get, getSetting } = require('../database');
const { checkAndResetDailyQuota } = require('./gmailPolicy');

// Transporter pool cache
const transporterPool = new Map();

/**
 * Normalizes 16-digit Google App Password (strips whitespace if user pastes with spaces)
 */
function cleanPassword(pass) {
  if (!pass) return '';
  return pass.replace(/\s+/g, '').trim();
}

function sanitizeAddressList(value) {
  if (!value) return '';
  return String(value)
    .split(/[,;]+/)
    .map((part) => part.replace(/[\r\n]/g, '').trim())
    .filter((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part))
    .join(', ');
}

/**
 * Creates or retrieves a cached Nodemailer transporter
 */
function getTransporter(account) {
  const poolKey = `${account.email}_${account.port}_${account.secure}`;
  
  if (transporterPool.has(poolKey)) {
    return transporterPool.get(poolKey);
  }

  const transporter = nodemailer.createTransport({
    host: account.host || 'smtp.gmail.com',
    port: Number(account.port) || 465,
    secure: Number(account.secure) === 1 || Number(account.port) === 465, // true for 465, false for 587
    auth: {
      user: account.email.trim(),
      pass: cleanPassword(account.app_password)
    },
    pool: true,
    maxConnections: 1, // Google strictly discourages high concurrency for individual Gmail mailboxes
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 1
  });

  transporterPool.set(poolKey, transporter);
  return transporter;
}

/**
 * Verifies SMTP connection & credentials
 */
async function verifyAccountConnection(account) {
  const transporter = nodemailer.createTransport({
    host: account.host || 'smtp.gmail.com',
    port: Number(account.port) || 465,
    secure: Number(account.secure) === 1 || Number(account.port) === 465,
    auth: {
      user: account.email.trim(),
      pass: cleanPassword(account.app_password)
    },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 12000
  });

  try {
    await transporter.verify();
    return { success: true, message: 'SMTP login succeeded. This mailbox can send.' };
  } catch (err) {
    let friendlyMsg = err.message;
    if (err.responseCode === 535 || err.message.includes('5.7.8') || err.message.includes('Username and Password not accepted')) {
      friendlyMsg = 'Login failed. Use a 16-character Google App Password, not the normal Gmail password, and turn on 2-Step Verification.';
    } else if (err.code === 'ECONNREFUSED') {
      friendlyMsg = `Connection refused on ${account.host || 'smtp.gmail.com'} port ${account.port || 465}. Nothing accepted the connection.`;
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || /timed out/i.test(err.message)) {
      friendlyMsg = `Could not reach ${account.host || 'smtp.gmail.com'} on port ${account.port || 465}. Check the network, or try port 587.`;
    } else if (err.code === 'ENOTFOUND') {
      friendlyMsg = `The mail server "${account.host || 'smtp.gmail.com'}" was not found. Check the SMTP host.`;
    } else if (/certificate|self signed|unable to verify/i.test(err.message)) {
      friendlyMsg = 'The mail server certificate was rejected. Check the host and port.';
    }
    return { success: false, error: friendlyMsg };
  } finally {
    transporter.close();
  }
}

/**
 * Sends a single email with Google compliance safeguards and quota increments
 */
async function sendSingleEmail({ account, recipient, subject, bodyHtml, bodyText, scheduledId = null, userId, fromName, cc, bcc }) {
  const cleanRecipient = String(recipient || '').replace(/[\r\n]/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanRecipient)) {
    throw new Error(`Invalid recipient address: ${cleanRecipient}`);
  }

  // 1. Quota check & reset, then re-read the counter so two sends cannot share one stale number
  const wasReset = checkAndResetDailyQuota(account);
  if (wasReset) {
    await run(
      'UPDATE smtp_accounts SET sent_today = 0, last_reset_date = ?, status = "ready", error_message = NULL WHERE id = ?',
      [account.last_reset_date, account.id]
    );
    account.sent_today = 0;
  }

  const fresh = await get('SELECT sent_today, daily_limit, is_active FROM smtp_accounts WHERE id = ?', [account.id]);
  if (!fresh || !fresh.is_active) {
    throw new Error(`Sending account ${account.email} is not active.`);
  }
  account.sent_today = fresh.sent_today || 0;

  const globalCap = Math.min(500, Math.max(50, Number(await getSetting('gmail_max_daily_limit', '450')) || 450));
  const maxLimit = Math.min(Number(fresh.daily_limit) || globalCap, globalCap);
  if (account.sent_today >= maxLimit) {
    await run(
      'UPDATE smtp_accounts SET status = "quota_exceeded", error_message = ? WHERE id = ?',
      [`Daily limit reached (Google Compliance: Max ${maxLimit}/day)`, account.id]
    );
    throw new Error(`Google Compliance Safety: Account ${account.email} has hit its daily limit of ${maxLimit} emails. Pausing to avoid Google suspension.`);
  }

  const enforceUnsub = (await getSetting('enforce_unsubscribe_header', '1')) !== '0';
  const supportEmail = String(await getSetting('support_email', account.email) || account.email).replace(/[\r\n<>]/g, '');
  const displayName = String(fromName || account.from_name || account.label || 'Parth Mailing')
    .replace(/[\r\n"]/g, '')
    .slice(0, 80) || 'Parth Mailing';
  const safeSubject = String(subject || '').replace(/[\r\n]/g, ' ').slice(0, 250);
  const safeCc = sanitizeAddressList(cc);
  const safeBcc = sanitizeAddressList(bcc);
  const headers = { 'X-Mailer': 'Parth-Mailing-Engine/1.0' };
  if (enforceUnsub && supportEmail) {
    headers['List-Unsubscribe'] = `<mailto:${supportEmail}?subject=unsubscribe>`;
  }

  const transporter = getTransporter(account);
  const mailOptions = {
    from: `"${displayName}" <${account.email}>`,
    to: cleanRecipient,
    subject: safeSubject,
    html: bodyHtml || '',
    text: bodyText || String(bodyHtml || '').replace(/<[^>]*>?/gm, ' '),
    cc: safeCc || undefined,
    bcc: safeBcc || undefined,
    headers
  };

  try {
    const info = await transporter.sendMail(mailOptions);

    // 4. Update account usage
    const nowIso = new Date().toISOString();
    await run(
      'UPDATE smtp_accounts SET sent_today = sent_today + 1, last_sent_at = ?, status = "ready", error_message = NULL WHERE id = ?',
      [nowIso, account.id]
    );
    account.sent_today = (account.sent_today || 0) + 1;

    // 5. Log success
    await run(
      `INSERT INTO email_logs (scheduled_id, user_id, smtp_account_id, recipient, subject, status, message_id, sent_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`,
      [scheduledId, userId, account.id, cleanRecipient, safeSubject, info.messageId || null, nowIso]
    );

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const nowIso = new Date().toISOString();
    const errMsg = err.message || 'Unknown sending failure';

    // Check if Google returned rate limit or auth error
    if (errMsg.includes('5.7.0') || errMsg.includes('Daily user sending quota exceeded')) {
      await run('UPDATE smtp_accounts SET status = "quota_exceeded", error_message = ? WHERE id = ?', [errMsg, account.id]);
    } else if (errMsg.includes('5.7.8') || errMsg.includes('Username and Password not accepted')) {
      await run('UPDATE smtp_accounts SET status = "error", error_message = ? WHERE id = ?', [errMsg, account.id]);
    }

    // Log failure
    await run(
      `INSERT INTO email_logs (scheduled_id, user_id, smtp_account_id, recipient, subject, status, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`,
      [scheduledId, userId, account.id, cleanRecipient, safeSubject, errMsg, nowIso]
    );

    throw err;
  }
}

module.exports = {
  verifyAccountConnection,
  sendSingleEmail,
  cleanPassword
};

