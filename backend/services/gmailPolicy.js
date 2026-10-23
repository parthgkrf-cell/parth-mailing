// Google Gmail Policy Compliance & Safety Engine
// Ensures all emails sent adhere strictly to Google's sending policies and anti-spam limits

const SPAM_TRIGGER_WORDS = [
  '100% free', 'act now', 'apply now', 'instant cash', 'fast cash',
  'risk-free', 'winner', 'claim your prize', 'congratulations you won',
  'no credit check', 'cure baldness', 'make money fast', 'earn $$$'
];

/**
 * Checks an account's quota and resets daily counters if a new day has arrived.
 * Google uses a 24-hour rolling window, represented safely by daily calendar reset.
 */
function checkAndResetDailyQuota(account) {
  const today = new Date().toISOString().split('T')[0];
  if (account.last_reset_date !== today) {
    account.sent_today = 0;
    account.last_reset_date = today;
    if (account.status === 'quota_exceeded') {
      account.status = 'ready';
      account.error_message = null;
    }
    return true; // was reset
  }
  return false;
}

/**
 * Pre-flight compliance validator for an email before scheduling or sending
 */
function asText(value) {
  return value == null ? '' : String(value);
}

function validateGmailCompliance(payload) {
  const issues = [];
  const warnings = [];
  const source = payload || {};
  const subject = asText(source.subject);
  const body_html = asText(source.body_html);
  const body_text = asText(source.body_text);
  const recipients = Array.isArray(source.recipients) ? source.recipients.map(asText) : [];

  if (!subject.trim()) {
    issues.push('Subject line is required.');
  }

  if (!body_html.trim() && !body_text.trim()) {
    issues.push('Message body is required.');
  }

  // Check all-caps subject
  if (subject.length > 5 && subject === subject.toUpperCase()) {
    warnings.push('Subject is in ALL CAPS. Gmail spam filters penalize uppercase subjects heavily.');
  }

  // Check excessive punctuation in subject
  if (/([!?$#]{2,})/.test(subject)) {
    warnings.push('Subject contains repeated exclamation/question marks or dollar signs, which triggers Google spam filters.');
  }

  // Check spam trigger phrases
  const lowerSubject = subject.toLowerCase();
  const lowerBody = (body_text + ' ' + body_html).toLowerCase();
  for (const trigger of SPAM_TRIGGER_WORDS) {
    if (lowerSubject.includes(trigger) || lowerBody.includes(trigger)) {
      warnings.push(`Contains spam-flagged phrase: "${trigger}". Consider rewording to improve inbox placement.`);
    }
  }

  // Recipient list check
  if (!recipients || recipients.length === 0) {
    issues.push('At least one recipient email address is required.');
  }

  // Email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalidEmails = recipients.filter(r => !emailRegex.test(r.trim()));
  if (invalidEmails.length > 0) {
    issues.push(`Invalid email address format detected: ${invalidEmails.slice(0, 3).join(', ')}${invalidEmails.length > 3 ? '...' : ''}`);
  }

  // HTML without text fallback
  if (body_html.trim() && !body_text.trim()) {
    warnings.push('Recommended to include plain-text version alongside HTML for optimal Gmail deliverability.');
  }

  const spamRiskScore = (warnings.length * 20); // 0 = lowest risk, 100 = high risk

  return {
    isValid: issues.length === 0,
    issues,
    warnings,
    spamRiskScore: Math.min(100, spamRiskScore),
    deliveryGrade: spamRiskScore === 0 ? 'A+' : spamRiskScore <= 20 ? 'A' : spamRiskScore <= 40 ? 'B' : 'C'
  };
}

/**
 * Calculates human-like pacing delay to avoid Google burst-detection triggers
 */
function calculateSafeDelay(baseIntervalSec = 15, jitterSec = 8) {
  const baseMs = Math.max(5, Number(baseIntervalSec) || 15) * 1000;
  const jitter = Math.max(0, Number(jitterSec) || 0);
  const randomJitterMs = jitter === 0 ? 0 : Math.floor(Math.random() * (jitter * 1000));
  return baseMs + randomJitterMs;
}

module.exports = {
  checkAndResetDailyQuota,
  validateGmailCompliance,
  calculateSafeDelay
};

