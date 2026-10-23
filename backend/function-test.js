/**
 * Exercises Parth Mailing functions without sending a real message.
 * Usage: node function-test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

const { validateGmailCompliance, checkAndResetDailyQuota, calculateSafeDelay } = require('./services/gmailPolicy');
const { applyMerge, tagUrlForGa4, parseRecipientPayload, normalizeEmail } = require('./services/campaign');
const { cleanPassword, verifyAccountConnection, sendSingleEmail } = require('./services/mailer');

const BASE = process.env.API_BASE || 'http://127.0.0.1:5000';
const MASTER_EMAIL = 'vekariyaparth127@gmail.com';
const MASTER_PASSWORD = 'MasterParth@2026';
const USER_EMAIL = 'qa-function-check@example.com';
const USER_PASSWORD = 'QaCheck#2026';
const APPROVAL_EMAIL = 'qa-approval-check@example.com';

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function unitTests() {
  const empty = validateGmailCompliance({ subject: '  ', body_html: '', recipients: [] });
  record('Compliance rejects an empty subject, body, and recipient list', !empty.isValid && empty.issues.length >= 3, empty.issues.join(' | '));

  const caps = validateGmailCompliance({
    subject: 'HELLO THERE',
    body_html: '<p>100% free offer</p>',
    recipients: ['person@example.com']
  });
  record('Compliance warns on all-caps and spam phrases', caps.isValid && caps.warnings.length >= 2, `grade ${caps.deliveryGrade}`);

  const badAddress = validateGmailCompliance({
    subject: 'Hello',
    body_html: '<p>Hi</p>',
    recipients: ['not-an-email', 42]
  });
  record('Compliance rejects a badly formed address', !badAddress.isValid, badAddress.issues.join(' | '));

  const merged = applyMerge('Hello {name}, from {SenderName}', {
    name: 'Ada',
    sender_name: 'Parth'
  });
  record('Merge tags are case-insensitive', merged === 'Hello Ada, from Parth', merged);

  const tracked = tagUrlForGa4('https://example.com/cfp.php#section06?utm_source=old', {
    enabled: true,
    source: 'ParthMailing',
    medium: 'email',
    campaign: '101',
    content: ''
  });
  record(
    'GA4 tags are placed before the hash',
    tracked.startsWith('https://example.com/cfp.php?') && tracked.includes('utm_source=ParthMailing') && tracked.endsWith('#section06'),
    tracked
  );

  const parsed = parseRecipientPayload('Ada <Ada@Example.com>, bad, second@example.com');
  record('Recipient text keeps only real addresses', parsed.length === 2 && parsed[0].email === 'ada@example.com', parsed.map((row) => row.email).join(', '));
  record('Angle-bracket addresses are unwrapped', normalizeEmail('Name <Person@Example.com>') === 'person@example.com');

  const quota = { last_reset_date: '2000-01-01', sent_today: 12, status: 'quota_exceeded' };
  record('Daily counter resets on a new calendar day', checkAndResetDailyQuota(quota) && quota.sent_today === 0 && quota.status === 'ready');

  const delay = calculateSafeDelay(15, 0);
  record('Pacing delay respects the base interval', delay === 15000, `${delay}ms`);
  record('App passwords ignore spaces', cleanPassword('abcd efgh ijkl mnop') === 'abcdefghijklmnop');

  let rejected = false;
  try {
    await sendSingleEmail({ account: { email: 'a@b.com' }, recipient: 'bad\r\nBcc: x@y.com', subject: 'Hi', bodyHtml: '<p>Hi</p>', userId: 1 });
  } catch (err) {
    rejected = /invalid recipient/i.test(err.message);
  }
  record('Header-injection recipient is rejected before SMTP', rejected);

  const verify = await verifyAccountConnection({
    email: 'nobody@example.com',
    app_password: 'abcdefghijklmnop',
    host: '127.0.0.1',
    port: 1,
    secure: 0
  });
  record('SMTP verify reports a refused connection', verify.success === false && /timed out|refused|could not reach|not found/i.test(verify.error), verify.error);

  const excel = await import(pathToFileURL(path.resolve(__dirname, '../frontend/src/utils/excelParse.js')).href);
  const normal = excel.parseSheetMatrix([
    ['Name', 'Email', 'Template', 'Sender Email', 'Sender Name', 'CC', 'BCC'],
    ['Ada Lovelace', 'Ada <ADA@Example.com>', 'Invite', 'from@example.com', 'Conference Desk', 'boss@example.com', 'hidden@example.com']
  ], 'book.xlsx', 'Sheet1');
  const row = normal.rows[0];
  record(
    'Excel import reads name, template, sender, cc, and bcc',
    normal.invalid === 0 && row.email === 'ada@example.com' && row.name === 'Ada Lovelace' && row.template === 'Invite' && row.sender_name === 'Conference Desk' && row.cc === 'boss@example.com' && row.bcc === 'hidden@example.com',
    JSON.stringify({ email: row?.email, name: row?.name, sender_name: row?.sender_name, cc: row?.cc, bcc: row?.bcc })
  );

  const bccOnly = excel.parseSheetMatrix([
    ['Email', 'BCC'],
    ['person@example.com', 'hidden@example.com']
  ]);
  record('BCC column is not mistaken for CC', bccOnly.rows[0].cc === '' && bccOnly.rows[0].bcc === 'hidden@example.com', JSON.stringify(bccOnly.rows[0]));

  const senderOnly = excel.parseSheetMatrix([
    ['Sender Name', 'Email'],
    ['Desk Name', 'person@example.com']
  ]);
  record('Sender Name is not used as the recipient name', senderOnly.rows[0].name === '' && senderOnly.rows[0].sender_name === 'Desk Name');

  const skipped = excel.parseSheetMatrix([
    ['Email'],
    ['not-an-email'],
    ['ok@example.com']
  ]);
  record('Invalid sheet rows are counted and skipped', skipped.invalid === 1 && skipped.rows.length === 1);

  const { normalizeSyncUrl, applyAccountSnapshot } = require('./services/accountSync');
  const { run, get } = require('./database');
  const driveUrl = normalizeSyncUrl('https://drive.google.com/file/d/abc123/view?usp=sharing');
  record('Drive link becomes a download link', driveUrl === 'https://drive.google.com/uc?export=download&id=abc123', driveUrl);
  const rawUrl = normalizeSyncUrl('https://github.com/parthgkrf-cell/parth-mailing/blob/main/config/accounts.sync.example.json');
  record('GitHub file link becomes a raw link', rawUrl.startsWith('https://raw.githubusercontent.com/') && rawUrl.includes('/main/config/accounts.sync.example.json'), rawUrl);
  let rejectedUrl = false;
  try { normalizeSyncUrl('http://example.com/accounts.json'); } catch (err) { rejectedUrl = /https/i.test(err.message); }
  record('Sync refuses links that are not Drive or GitHub', rejectedUrl);

  const skippedAdd = await applyAccountSnapshot({
    authoritative: false,
    accounts: [{ email: 'qa-sync@example.com', label: 'QA Sync', is_active: 1 }]
  });
  record('Sync does not add a mailbox that has no app password', skippedAdd.notes.some((note) => note.includes('qa-sync@example.com')), skippedAdd.summary);
  const masterRow = await get(`SELECT id FROM users WHERE role = 'master' ORDER BY id ASC`);
  await run(
    `INSERT INTO smtp_accounts (user_id, label, email, app_password, host, port, secure, daily_limit, sent_today, last_reset_date, is_active, status, from_name)
     VALUES (?, 'Old', 'qa-sync@example.com', 'abcdefghijklmnop', 'smtp.gmail.com', 465, 1, 450, 0, '2026-01-01', 1, 'ready', 'Old')`,
    [masterRow.id]
  );
  await applyAccountSnapshot({
    authoritative: false,
    accounts: [{ email: 'qa-sync@example.com', label: 'Renamed desk', from_name: 'Desk', is_active: 1, assigned_to: [] }]
  });
  const renamed = await get(`SELECT label, from_name, app_password FROM smtp_accounts WHERE email = ?`, ['qa-sync@example.com']);
  record(
    'Sync can rename a mailbox and keep the saved password',
    renamed && renamed.label === 'Renamed desk' && renamed.from_name === 'Desk' && renamed.app_password === 'abcdefghijklmnop',
    renamed && renamed.label
  );
  await run(`DELETE FROM smtp_accounts WHERE email = ?`, ['qa-sync@example.com']);
}

async function httpTests() {
  const health = await api('/api/health');
  record('Health check', health.status === 200 && health.data.status === 'ok', health.data.app || health.data.error);

  const missing = await api('/api/auth/login', { method: 'POST', body: {} });
  record('Login requires email and password', missing.status === 400);

  const wrong = await api('/api/auth/login', { method: 'POST', body: { email: MASTER_EMAIL, password: 'wrong-password' } });
  record('Wrong password is rejected', wrong.status === 401);

  const masterLogin = await api('/api/auth/login', { method: 'POST', body: { email: MASTER_EMAIL, password: MASTER_PASSWORD } });
  record('Master login', masterLogin.status === 200 && masterLogin.data.user?.role === 'master', masterLogin.data.error || masterLogin.data.user?.email);
  if (masterLogin.status !== 200) {
    record('Remaining signed-in tests', false, 'Master login failed, so account and campaign tests were skipped.');
    return;
  }
  const master = masterLogin.data.token;

  const me = await api('/api/auth/me', { token: master });
  record('Session profile', me.status === 200 && me.data.user.email === MASTER_EMAIL);

  const bare = await api('/api/emails/stats');
  record('Protected routes reject a missing token', bare.status === 401);

  record('Register rejects a short password', (await api('/api/auth/register', { method: 'POST', body: { name: 'QA', email: USER_EMAIL, password: '123' } })).status === 400);
  record('Register rejects a bad email', (await api('/api/auth/register', { method: 'POST', body: { name: 'QA', email: 'not-an-email', password: USER_PASSWORD } })).status === 400);

  let userToken = null;
  let userId = null;
  const existingUsers = await api('/api/master/users', { token: master });
  const already = (existingUsers.data.users || []).find((user) => user.email === USER_EMAIL);
  if (already) {
    await api(`/api/master/users/${already.id}`, { method: 'DELETE', token: master });
  }
  const registered = await api('/api/auth/register', { method: 'POST', body: { name: 'QA Checker', email: USER_EMAIL, password: USER_PASSWORD } });
  record('User registration', registered.status === 201 && !!registered.data.token, registered.data.error || registered.data.message);
  userToken = registered.data.token;

  const userLogin = await api('/api/auth/login', { method: 'POST', body: { email: USER_EMAIL, password: USER_PASSWORD } });
  record('New user can sign in', userLogin.status === 200, userLogin.data.error);
  userToken = userLogin.data.token || userToken;

  const usersAfter = await api('/api/master/users', { token: master });
  userId = (usersAfter.data.users || []).find((user) => user.email === USER_EMAIL)?.id;

  record('Normal user cannot open the master panel', (await api('/api/master/stats', { token: userToken })).status === 403);
  record('Normal user cannot add a sending account', (await api('/api/accounts', { method: 'POST', token: userToken, body: { label: 'X', email: 'a@b.com', app_password: 'short' } })).status === 403);
  record('Normal user cannot change GA4', (await api('/api/emails/ga4', { method: 'POST', token: userToken, body: { tracking: { source: 'hijack' } } })).status === 403);
  record('Normal user can read GA4', (await api('/api/emails/ga4', { token: userToken })).status === 200);
  record('Normal user cannot reset a quota', (await api('/api/accounts/1/reset-quota', { method: 'POST', token: userToken })).status === 403);
  record('Normal user cannot run the Super Admin mailbox test', (await api('/api/master/accounts/test-all', { method: 'POST', token: userToken })).status === 403);
  const badSync = await api('/api/master/settings', { method: 'POST', token: master, body: { settings: { accounts_sync_url: 'https://example.com/accounts.json' } } });
  record('Mailbox sync link must be Drive or GitHub', badSync.status === 400, badSync.data.error);

  const badCompliance = await api('/api/emails/check-compliance', { method: 'POST', token: userToken, body: { subject: '', recipients: '' } });
  record('Compliance endpoint reports problems', badCompliance.status === 200 && badCompliance.data.isValid === false);

  const createdTemplate = await api('/api/emails/templates', {
    method: 'POST',
    token: userToken,
    body: { name: 'QA Invite', subject: 'Hello {Name}', body_html: '<p>Hi {Name}</p>', cc: 'cc@example.com', bcc: '' }
  });
  record('Save template', createdTemplate.status === 201, createdTemplate.data.error);
  const templateId = createdTemplate.data.template?.id;
  const updatedTemplate = await api(`/api/emails/templates/${templateId}`, {
    method: 'PUT',
    token: userToken,
    body: { subject: 'Hello {Name} updated' }
  });
  record('Update template', updatedTemplate.status === 200 && updatedTemplate.data.template.subject.includes('updated'));

  const preview = await api('/api/emails/preview-merge', {
    method: 'POST',
    token: userToken,
    body: { subject: 'Hello {Name}', body_html: '<p>Hi {Name}</p><a href="https://example.com/cfp.php#section06">Open</a>', recipient: { email: 'ada@example.com', name: 'Ada' } }
  });
  record(
    'Preview merge fills the name and tracks the link',
    preview.status === 200 && preview.data.subject === 'Hello Ada' && preview.data.html.includes('utm_source='),
    preview.data.subject
  );

  const draft = await api('/api/emails/drafts', {
    method: 'POST',
    token: userToken,
    body: { title: 'QA Draft', subject: 'Draft subject', body_html: '<p>Draft</p>', recipients: JSON.stringify([{ email: 'ada@example.com' }]), cc: 'cc@example.com', bcc: 'bcc@example.com' }
  });
  record('Save draft', draft.status === 201, draft.data.error);
  const draftId = draft.data.draftId;
  record('Update draft', (await api(`/api/emails/drafts/${draftId}`, { method: 'PUT', token: userToken, body: { subject: 'Draft subject 2', cc: 'other@example.com' } })).status === 200);
  const drafts = await api('/api/emails/drafts', { token: userToken });
  const stored = (drafts.data.drafts || []).find((item) => item.id === draftId);
  record('Draft keeps cc and bcc', stored && stored.subject === 'Draft subject 2' && stored.cc === 'other@example.com' && stored.bcc === 'bcc@example.com', stored ? `cc=${stored.cc}` : 'missing');
  record('Delete draft', (await api(`/api/emails/drafts/${draftId}`, { method: 'DELETE', token: userToken })).status === 200);

  const noBody = await api('/api/emails/schedules', {
    method: 'POST',
    token: userToken,
    body: { subject: 'Hello', recipients: ['ada@example.com'], body_html: '', scheduled_for: '2099-01-01T00:00:00.000Z' }
  });
  record('Schedule rejects an empty body', noBody.status === 400, noBody.data.error);

  const foreignAccount = await api('/api/emails/schedules', {
    method: 'POST',
    token: userToken,
    body: { subject: 'Hello', recipients: ['ada@example.com'], body_html: '<p>Hi</p>', scheduled_for: '2099-01-01T00:00:00.000Z', smtp_account_id: 999999 }
  });
  record('Schedule rejects a mailbox the user does not have', foreignAccount.status === 403, foreignAccount.data.error);

  const settingsBefore = await api('/api/master/settings', { token: master });
  const originalInterval = settingsBefore.data.settings?.min_interval_seconds || '15';
  const originalName = settingsBefore.data.settings?.app_name || 'Parth mailing';
  const originalApproval = settingsBefore.data.settings?.require_user_approval || '0';

  await api('/api/master/settings', { method: 'POST', token: master, body: { settings: { min_interval_seconds: '25', app_name: 'Parth mailing QA', not_a_real_setting: 'nope' } } });
  const renamed = await api('/api/health');
  record('App name setting is returned by health', renamed.data.app === 'Parth mailing QA', renamed.data.app);
  const junk = await api('/api/master/settings', { token: master });
  record('Unknown setting keys are ignored', junk.data.settings.not_a_real_setting == null);

  const queued = await api('/api/emails/schedules', {
    method: 'POST',
    token: userToken,
    body: {
      subject: 'QA future campaign',
      recipients: [{ email: 'ada@example.com', name: 'Ada' }],
      body_html: '<p>Hello {Name}</p>',
      scheduled_for: '2099-01-01T00:00:00.000Z',
      interval_seconds: 10,
      random_jitter: 3
    }
  });
  record('Queue a future campaign', queued.status === 201, queued.data.error || queued.data.message);
  const scheduleId = queued.data.scheduleId;
  const listed = await api('/api/emails/schedules', { token: userToken });
  const job = (listed.data.schedules || []).find((item) => item.id === scheduleId);
  record('Master minimum delay overrides a shorter request', job && job.interval_seconds >= 25, job ? `interval ${job.interval_seconds}` : 'missing');
  record('Pause campaign', (await api(`/api/emails/schedules/${scheduleId}/pause`, { method: 'PUT', token: userToken })).status === 200);
  record('Pause again is rejected', (await api(`/api/emails/schedules/${scheduleId}/pause`, { method: 'PUT', token: userToken })).status === 409);
  record('Resume campaign', (await api(`/api/emails/schedules/${scheduleId}/resume`, { method: 'PUT', token: userToken })).status === 200);
  record('Delete campaign', (await api(`/api/emails/schedules/${scheduleId}`, { method: 'DELETE', token: userToken })).status === 200);
  record('Delete missing campaign is a 404', (await api(`/api/emails/schedules/${scheduleId}`, { method: 'DELETE', token: userToken })).status === 404);

  const blast = await api('/api/emails/send-now', {
    method: 'POST',
    token: userToken,
    body: {
      subject: 'Hello',
      body_html: '<p>Hi</p>',
      recipients: Array.from({ length: 11 }, (_, index) => `person${index}@example.com`)
    }
  });
  record('Send-now refuses more than 10 recipients', blast.status === 400 && /schedule/i.test(blast.data.error || ''), blast.data.error);

  const noMailbox = await api('/api/emails/send-now', {
    method: 'POST',
    token: userToken,
    body: { subject: 'Hello', body_html: '<p>Hi</p>', recipients: ['ada@example.com'] }
  });
  record('Send-now without a mailbox does not pretend success', noMailbox.status === 400, noMailbox.data.error);

  record('Account form requires a label', (await api('/api/accounts', { method: 'POST', token: master, body: { email: 'a@gmail.com' } })).status === 400);
  record('Account form rejects a short app password before SMTP', (await api('/api/accounts', { method: 'POST', token: master, body: { label: 'QA', email: 'a@gmail.com', app_password: 'short' } })).status === 400);

  record('User stats load', (await api('/api/emails/stats', { token: userToken })).status === 200);
  record('User logs load', (await api('/api/emails/logs', { token: userToken })).status === 200);
  record('Master stats load', (await api('/api/master/stats', { token: master })).status === 200);
  record('Master account fleet loads', (await api('/api/master/accounts', { token: master })).status === 200);
  record('Master logs load', (await api('/api/master/logs', { token: master })).status === 200);
  record('Assignment list loads', (await api(`/api/master/users/${userId}/accounts`, { token: master })).status === 200);
  record('Assigning no mailboxes succeeds', (await api(`/api/master/users/${userId}/accounts`, { method: 'PUT', token: master, body: { account_ids: [] } })).status === 200);

  await api('/api/master/settings', { method: 'POST', token: master, body: { settings: { require_user_approval: '1' } } });
  const pending = await api('/api/auth/register', { method: 'POST', body: { name: 'Needs Approval', email: APPROVAL_EMAIL, password: USER_PASSWORD } });
  record('Approval mode holds a new account', pending.status === 201 && pending.data.requiresApproval === true, pending.data.error || pending.data.message);
  const blocked = await api('/api/auth/login', { method: 'POST', body: { email: APPROVAL_EMAIL, password: USER_PASSWORD } });
  record('Pending user cannot sign in', blocked.status === 403, blocked.data.error);
  const pendingUser = (await api('/api/master/users', { token: master })).data.users.find((user) => user.email === APPROVAL_EMAIL);
  record('Master can approve a user', (await api(`/api/master/users/${pendingUser.id}/approve`, { method: 'PUT', token: master })).status === 200);
  record('Approved user can sign in', (await api('/api/auth/login', { method: 'POST', body: { email: APPROVAL_EMAIL, password: USER_PASSWORD } })).status === 200);
  record('Master cannot demote themselves', (await api(`/api/master/users/${me.data.user.id}/role`, { method: 'PUT', token: master, body: { role: 'user' } })).status === 400);
  record('Master can change another user role and change it back', (await api(`/api/master/users/${pendingUser.id}/role`, { method: 'PUT', token: master, body: { role: 'master' } })).status === 200);
  await api(`/api/master/users/${pendingUser.id}/role`, { method: 'PUT', token: master, body: { role: 'user' } });
  record('Master can suspend and the user is then blocked', (await api(`/api/master/users/${pendingUser.id}/status`, { method: 'PUT', token: master })).status === 200);
  const suspended = await api('/api/auth/login', { method: 'POST', body: { email: APPROVAL_EMAIL, password: USER_PASSWORD } });
  record('Suspended user cannot sign in', suspended.status === 403, suspended.data.error);
  record('Master can delete a user', (await api(`/api/master/users/${pendingUser.id}`, { method: 'DELETE', token: master })).status === 200);
  record('Master cannot delete their own account', (await api(`/api/master/users/${me.data.user.id}`, { method: 'DELETE', token: master })).status === 400);

  if (templateId) {
    record('Delete template', (await api(`/api/emails/templates/${templateId}`, { method: 'DELETE', token: userToken })).status === 200);
  }
  if (userId) {
    record('Cleanup test user', (await api(`/api/master/users/${userId}`, { method: 'DELETE', token: master })).status === 200);
  }
  await api('/api/master/settings', {
    method: 'POST',
    token: master,
    body: { settings: { min_interval_seconds: originalInterval, app_name: originalName, require_user_approval: originalApproval } }
  });
  const restored = await api('/api/health');
  record('Settings restored after the test', restored.data.app === originalName, restored.data.app);
}

async function main() {
  await unitTests();
  try {
    await httpTests();
  } catch (err) {
    record('HTTP test run', false, err.message);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main();
