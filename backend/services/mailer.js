const nodemailer = require('nodemailer');
const { run, get } = require('../database');
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
    tls: {
      rejectUnauthorized: false
    }
  });

  try {
    await transporter.verify();
    return { success: true, message: 'SMTP connection & Google credentials verified successfully!' };
  } catch (err) {
    let friendlyMsg = err.message;
    if (err.responseCode === 535 || err.message.includes('5.7.8') || err.message.includes('Username and Password not accepted')) {
      friendlyMsg = 'Authentication failed. Make sure you use a 16-character Google App Password (not your normal Gmail password) and that 2-Step Verification is enabled on your Google Account.';
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      friendlyMsg = 'Connection timed out. Check network or try port 587 with STARTTLS.';
    }
    return { success: false, error: friendlyMsg };
  }
}

/**
 * Sends a single email with Google compliance safeguards and quota increments
 */
async function sendSingleEmail({ account, recipient, subject, bodyHtml, bodyText, scheduledId = null, userId, fromName, cc, bcc }) {
  // 1. Quota check & reset
  const wasReset = checkAndResetDailyQuota(account);
  if (wasReset) {
    await run(
      'UPDATE smtp_accounts SET sent_today = 0, last_reset_date = ?, status = "ready", error_message = NULL WHERE id = ?',
      [account.last_reset_date, account.id]
    );
  }

  // 2. Strict policy limit check
  const maxLimit = account.daily_limit || 450;
  if (account.sent_today >= maxLimit) {
    await run(
      'UPDATE smtp_accounts SET status = "quota_exceeded", error_message = "Daily limit reached (Google Compliance: Max 450/day)" WHERE id = ?',
      [account.id]
    );
    throw new Error(`Google Compliance Safety: Account ${account.email} has hit its daily limit of ${maxLimit} emails. Pausing to avoid Google suspension.`);
  }

  // 3. Prepare headers
  const transporter = getTransporter(account);
  const supportEmail = account.email;

  const displayName = fromName || account.from_name || account.label || 'Parth Mailing';
  const mailOptions = {
    from: `"${displayName}" <${account.email}>`,
    to: recipient,
    subject: subject,
    html: bodyHtml,
    text: bodyText || bodyHtml.replace(/<[^>]*>?/gm, ''), // fallback plain text
    cc: cc || undefined,
    bcc: bcc || undefined,
    headers: {
      'List-Unsubscribe': `<mailto:${supportEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Mailer': 'Parth-Mailing-Engine/1.0'
    }
  };

  try {
    const info = await transporter.sendMail(mailOptions);

    // 4. Update account usage
    const newSentToday = account.sent_today + 1;
    const nowIso = new Date().toISOString();
    await run(
      'UPDATE smtp_accounts SET sent_today = ?, last_sent_at = ?, status = "ready", error_message = NULL WHERE id = ?',
      [newSentToday, nowIso, account.id]
    );
    account.sent_today = newSentToday;

    // 5. Log success
    await run(
      `INSERT INTO email_logs (scheduled_id, user_id, smtp_account_id, recipient, subject, status, message_id, sent_at)
       VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)`,
      [scheduledId, userId, account.id, recipient, subject, info.messageId || null, nowIso]
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
      [scheduledId, userId, account.id, recipient, subject, errMsg, nowIso]
    );

    throw err;
  }
}

module.exports = {
  verifyAccountConnection,
  sendSingleEmail,
  cleanPassword
};

