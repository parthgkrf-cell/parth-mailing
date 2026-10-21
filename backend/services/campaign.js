const { get, all } = require('../database');

const EMAIL_RE = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;

function normalizeEmail(value) {
  let text = String(value || '').replace(/\u00a0/g, '').replace(/\u200b/g, '').trim().toLowerCase();
  const wrapped = text.match(/<([^>]+)>/);
  if (wrapped) text = wrapped[1].trim().toLowerCase();
  return text;
}

function defaultGa4() {
  return {
    enabled: true,
    source: 'ParthMailing',
    medium: 'email',
    campaign: '101',
    content: '',
    sampleUrl: 'https://example.com/cfp.php#section06'
  };
}

async function loadGa4Settings() {
  const rows = await all('SELECT key, value FROM system_settings WHERE key LIKE "ga4_%"');
  const map = {};
  rows.forEach((row) => { map[row.key] = row.value; });
  return {
    enabled: map.ga4_enabled !== '0',
    source: map.ga4_utm_source || 'ParthMailing',
    medium: map.ga4_utm_medium || 'email',
    campaign: map.ga4_utm_campaign == null ? '101' : map.ga4_utm_campaign,
    content: map.ga4_utm_content || '',
    sampleUrl: map.ga4_sample_url || 'https://example.com/cfp.php#section06'
  };
}

function tagUrlForGa4(url, tracking) {
  const raw = String(url || '').trim().replace(/&amp;/gi, '&').replace(/&#38;/gi, '&');
  if (!/^https?:\/\//i.test(raw)) return url;
  const tags = tracking || defaultGa4();
  let hash = '';
  let base = raw;
  const hashAt = raw.indexOf('#');
  if (hashAt >= 0) {
    hash = raw.slice(hashAt + 1);
    base = raw.slice(0, hashAt);
  }
  let hidden = '';
  const queryInHash = hash.indexOf('?');
  if (queryInHash >= 0) {
    hidden = hash.slice(queryInHash + 1);
    hash = hash.slice(0, queryInHash);
  }
  const queryAt = base.indexOf('?');
  const path = queryAt >= 0 ? base.slice(0, queryAt) : base;
  const params = new URLSearchParams(queryAt >= 0 ? base.slice(queryAt + 1) : '');
  if (hidden) {
    new URLSearchParams(hidden).forEach((value, key) => params.append(key, value));
  }
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((key) => params.delete(key));
  if (tags.source) params.set('utm_source', tags.source);
  if (tags.medium) params.set('utm_medium', tags.medium);
  if (tags.campaign) params.set('utm_campaign', tags.campaign);
  if (tags.content) params.set('utm_content', tags.content);
  const query = params.toString();
  return path + (query ? `?${query}` : '') + (hash ? `#${hash}` : '');
}

function applyEmailTracking(html, tracking) {
  if (!html || !tracking || tracking.enabled === false) return html;
  return String(html).replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, url) => {
    return `href=${quote}${tagUrlForGa4(url, tracking)}${quote}`;
  });
}

function applyMerge(template, rec) {
  const fields = rec.fields && typeof rec.fields === 'object' ? rec.fields : {};
  const map = {
    Name: rec.name || [rec.first_name, rec.last_name].filter(Boolean).join(' ').trim(),
    FirstName: rec.first_name || '',
    LastName: rec.last_name || '',
    Email: rec.email || '',
    Affiliation: rec.affiliation || rec.company || fields.Affiliation || '',
    Company: rec.company || rec.affiliation || '',
    Sender: rec.sender_name || rec.from_name || rec.sender || '',
    SenderName: rec.sender_name || rec.from_name || '',
    Template: rec.template || rec.template_name || '',
    Session: rec.session || fields.Session || '',
    Date: rec.date || fields.Date || '',
    Time: rec.time || fields.Time || '',
    CC: rec.cc || '',
    BCC: rec.bcc || '',
    ...fields
  };
  return String(template || '').replace(/\{([^}]+)\}/g, (_, key) => {
    const found = Object.keys(map).find((k) => k.toLowerCase() === String(key).trim().toLowerCase());
    return found != null ? String(map[found] ?? '') : `{${key}}`;
  });
}

async function listSendableAccounts(user) {
  if (user.role === 'master') {
    return all('SELECT * FROM smtp_accounts WHERE is_active = 1 ORDER BY id DESC');
  }
  const own = await all('SELECT * FROM smtp_accounts WHERE user_id = ? AND is_active = 1 ORDER BY id DESC', [user.id]);
  const assigned = await all(`
    SELECT a.* FROM smtp_accounts a
    INNER JOIN account_assignments aa ON aa.smtp_account_id = a.id
    WHERE aa.user_id = ? AND a.is_active = 1
    ORDER BY a.id DESC
  `, [user.id]);
  const seen = new Set();
  const merged = [];
  for (const row of [...assigned, ...own]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

async function resolveSendableAccount(user, accountId, senderHint) {
  const allowed = await listSendableAccounts(user);
  if (accountId) {
    const match = allowed.find((item) => Number(item.id) === Number(accountId));
    if (match) return match;
  }
  const hint = String(senderHint || '').trim().toLowerCase();
  if (hint) {
    const byEmail = allowed.find((item) => String(item.email).toLowerCase() === normalizeEmail(hint));
    if (byEmail) return byEmail;
    const byLabel = allowed.find((item) => String(item.label || '').toLowerCase() === hint);
    if (byLabel) return byLabel;
    const byName = allowed.find((item) => String(item.from_name || '').toLowerCase() === hint);
    if (byName) return byName;
  }
  return allowed[0] || null;
}

function parseRecipientPayload(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (typeof item === 'string') return { email: normalizeEmail(item) };
      return {
        email: normalizeEmail(item.email),
        name: item.name || '',
        first_name: item.first_name || '',
        last_name: item.last_name || '',
        company: item.company || item.affiliation || '',
        affiliation: item.affiliation || item.company || '',
        template: item.template || item.template_name || '',
        sender: item.sender || item.sender_email || '',
        sender_name: item.sender_name || item.from_name || '',
        smtp_account_id: item.smtp_account_id || null,
        cc: item.cc || '',
        bcc: item.bcc || '',
        date: item.date || '',
        time: item.time || '',
        session: item.session || '',
        fields: item.fields || {}
      };
    }).filter((item) => EMAIL_RE.test(item.email));
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parseRecipientPayload(parsed);
  } catch (e) {
    // not json
  }
  return String(raw)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'))
    .map((email) => ({ email: normalizeEmail(email) }));
}

module.exports = {
  defaultGa4,
  loadGa4Settings,
  tagUrlForGa4,
  applyEmailTracking,
  applyMerge,
  listSendableAccounts,
  resolveSendableAccount,
  parseRecipientPayload,
  normalizeEmail
};
