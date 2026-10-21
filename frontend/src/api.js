const API_BASE = '/api';

async function request(endpoint, options = {}) {
  const token = localStorage.getItem('parth_mailing_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.error || (data.issues ? data.issues.join(' ') : 'Request failed');
    throw new Error(errorMsg);
  }

  return data;
}

export const api = {
  // Auth
  login: (email, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (name, email, password) => request('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  getMe: () => request('/auth/me'),

  // Accounts
  getAccounts: (all = false) => request(`/accounts${all ? '?all=true' : ''}`),
  addAccount: (payload) => request('/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  testAccount: (id) => request(`/accounts/${id}/test`, { method: 'POST' }),
  updateAccount: (id, payload) => request(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  resetQuota: (id) => request(`/accounts/${id}/reset-quota`, { method: 'POST' }),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),

  // Emails & Drafts & Schedules
  getStats: () => request('/emails/stats'),
  checkCompliance: (payload) => request('/emails/check-compliance', { method: 'POST', body: JSON.stringify(payload) }),
  sendNow: (payload) => request('/emails/send-now', { method: 'POST', body: JSON.stringify(payload) }),
  getDrafts: () => request('/emails/drafts'),
  saveDraft: (payload) => request('/emails/drafts', { method: 'POST', body: JSON.stringify(payload) }),
  updateDraft: (id, payload) => request(`/emails/drafts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteDraft: (id) => request(`/emails/drafts/${id}`, { method: 'DELETE' }),
  getSchedules: () => request('/emails/schedules'),
  createSchedule: (payload) => request('/emails/schedules', { method: 'POST', body: JSON.stringify(payload) }),
  pauseSchedule: (id) => request(`/emails/schedules/${id}/pause`, { method: 'PUT' }),
  resumeSchedule: (id) => request(`/emails/schedules/${id}/resume`, { method: 'PUT' }),
  deleteSchedule: (id) => request(`/emails/schedules/${id}`, { method: 'DELETE' }),
  getLogs: (limit = 100) => request(`/emails/logs?limit=${limit}`),
  getTemplates: () => request('/emails/templates'),
  saveTemplate: (payload) => request('/emails/templates', { method: 'POST', body: JSON.stringify(payload) }),
  updateTemplate: (id, payload) => request(`/emails/templates/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteTemplate: (id) => request(`/emails/templates/${id}`, { method: 'DELETE' }),
  getGa4: () => request('/emails/ga4'),
  saveGa4: (tracking) => request('/emails/ga4', { method: 'POST', body: JSON.stringify({ tracking }) }),
  previewMerge: (payload) => request('/emails/preview-merge', { method: 'POST', body: JSON.stringify(payload) }),
  getUserAccounts: (id) => request(`/master/users/${id}/accounts`),
  assignUserAccounts: (id, account_ids) => request(`/master/users/${id}/accounts`, { method: 'PUT', body: JSON.stringify({ account_ids }) }),

  // Master Admin
  getMasterStats: () => request('/master/stats'),
  getMasterUsers: () => request('/master/users'),
  toggleUserStatus: (id) => request(`/master/users/${id}/status`, { method: 'PUT' }),
  approveUser: (id) => request(`/master/users/${id}/approve`, { method: 'PUT' }),
  changeUserRole: (id, role) => request(`/master/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  deleteUser: (id) => request(`/master/users/${id}`, { method: 'DELETE' }),
  getMasterSettings: () => request('/master/settings'),
  updateMasterSettings: (settings) => request('/master/settings', { method: 'POST', body: JSON.stringify({ settings }) }),
  getMasterAccounts: () => request('/master/accounts'),
  getMasterLogs: (limit = 200) => request(`/master/logs?limit=${limit}`)
};

