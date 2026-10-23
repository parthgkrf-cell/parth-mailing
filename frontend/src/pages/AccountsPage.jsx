import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { 
  Mail, Plus, ShieldCheck, CheckCircle, AlertCircle, 
  Trash2, RefreshCw, Key, HelpCircle, ExternalLink, Power
} from 'lucide-react';

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // Form states
  const [label, setLabel] = useState('');
  const [fromName, setFromName] = useState('');
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [port, setPort] = useState('465');
  const [dailyLimit, setDailyLimit] = useState('450');
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  // Action status per account
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState({});
  const [feed, setFeed] = useState(null);

  useEffect(() => {
    loadAccounts(false);
    const timer = setInterval(() => loadAccounts(true), 5000);
    return () => clearInterval(timer);
  }, []);

  const loadAccounts = async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      const res = await api.getAccounts();
      setAccounts(res.accounts || []);
      setFeed(res);
    } catch (err) {
      console.error('Failed to load accounts:', err);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  const handleAddAccount = async (e) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');
    setFormLoading(true);

    try {
      await api.addAccount({
        label,
        from_name: fromName || label,
        email,
        app_password: appPassword,
        host: 'smtp.gmail.com',
        port: Number(port),
        secure: Number(port) === 465 ? 1 : 0,
        daily_limit: Number(dailyLimit)
      });
      setFormSuccess('Google SMTP connection verified and account added successfully!');
      setTimeout(() => {
        setShowAddModal(false);
        setLabel('');
        setFromName('');
        setEmail('');
        setAppPassword('');
        setFormSuccess('');
        loadAccounts();
      }, 1200);
    } catch (err) {
      setFormError(err.message || 'Failed to add account.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleTestConnection = async (id) => {
    setTestingId(id);
    setTestResult(prev => ({ ...prev, [id]: null }));
    try {
      const res = await api.testAccount(id);
      setTestResult(prev => ({ ...prev, [id]: { success: true, message: res.message } }));
      loadAccounts();
    } catch (err) {
      setTestResult(prev => ({ ...prev, [id]: { success: false, message: err.message } }));
    } finally {
      setTestingId(null);
    }
  };

  const handleResetQuota = async (id) => {
    try {
      await api.resetQuota(id);
      loadAccounts();
    } catch (err) {
      alert(err.message || 'Failed to reset quota');
    }
  };

  const handleToggleActive = async (account) => {
    try {
      await api.updateAccount(account.id, { is_active: !account.is_active });
      loadAccounts();
    } catch (err) {
      alert(err.message || 'Failed to toggle account');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this Gmail sending account from Parth Mailing?')) return;
    try {
      await api.deleteAccount(id);
      loadAccounts();
    } catch (err) {
      alert(err.message || 'Failed to delete account');
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Mail className="w-6 h-6 text-indigo-400" />
            Connected Gmail Accounts
          </h2>
          <p className="text-slate-300 text-sm">
            Manage your Google accounts, 16-digit App Passcodes, and monitor daily quotas.
            {feed?.sync_enabled ? ` Live sync: ${feed.sync_status || 'waiting for the Drive or GitHub file.'}` : ' This list refreshes every few seconds.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl border border-slate-700 flex items-center gap-1.5 transition-colors"
          >
            <HelpCircle className="w-4 h-4 text-sky-400" />
            {showGuide ? 'Hide Passcode Guide' : 'How to get 16-digit Passcode?'}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl flex items-center gap-2 shadow-lg shadow-indigo-600/25 transition-all"
          >
            <Plus className="w-4 h-4" />
            Connect Gmail Account
          </button>
        </div>
      </div>

      {/* Guide Box (Expandable) */}
      {showGuide && (
        <div className="bg-indigo-950/40 border border-indigo-800/60 rounded-2xl p-5 text-sm text-indigo-200/90 space-y-3">
          <div className="flex items-center gap-2 font-bold text-white">
            <Key className="w-4 h-4 text-indigo-400" />
            Generating your 16-digit Google App Password:
          </div>
          <ol className="list-decimal list-inside space-y-1.5 text-xs text-slate-300 pl-1 leading-relaxed">
            <li>Ensure <strong>2-Step Verification</strong> is enabled on your Google Account (<a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer" className="text-indigo-400 underline inline-flex items-center gap-0.5">Google Security <ExternalLink className="w-3 h-3" /></a>).</li>
            <li>Visit the App Passwords page: <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-indigo-400 underline inline-flex items-center gap-0.5">myaccount.google.com/apppasswords <ExternalLink className="w-3 h-3" /></a>.</li>
            <li>Give it an App name (e.g. <code>Parth Mailing</code>) and click <strong>Create</strong>.</li>
            <li>Google will present a 16-character passcode like <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-300">abcd efgh ijkl mnop</code>.</li>
            <li>Copy and paste it into the field below. Never share your primary account password.</li>
          </ol>
        </div>
      )}

      {/* Accounts List */}
      {loading ? (
        <div className="text-center py-12 text-slate-500">Loading accounts...</div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/60 border border-slate-800 rounded-2xl">
          <Mail className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-white">No accounts connected yet</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1 mb-4">
            Connect one or more Gmail accounts with 16-digit app passwords to start scheduling and drafting.
          </p>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl"
          >
            Connect Account Now
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {accounts.map((acc) => {
            const usagePercent = Math.min(100, Math.round(((acc.sent_today || 0) / (acc.daily_limit || 450)) * 100));

            return (
              <div
                key={acc.id}
                className={`bg-slate-900/90 border rounded-2xl p-5 shadow-xl space-y-4 transition-all ${
                  acc.is_active ? 'border-slate-800 hover:border-slate-700' : 'border-slate-800/40 opacity-75'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-white text-base">{acc.label}</h3>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        acc.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                        acc.status === 'quota_exceeded' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                        'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}>
                        {acc.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 font-mono">{acc.email}</p>
                  </div>

                  <button
                    onClick={() => handleToggleActive(acc)}
                    className={`p-1.5 rounded-lg border transition-colors ${
                      acc.is_active 
                        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20' 
                        : 'text-slate-500 bg-slate-800 border-slate-700 hover:bg-slate-700'
                    }`}
                    title={acc.is_active ? 'Account is Active (Click to Pause)' : 'Account is Paused (Click to Activate)'}
                  >
                    <Power className="w-4 h-4" />
                  </button>
                </div>

                {/* Quota Progress */}
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80">
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                    <span>Today's Sent Quota:</span>
                    <span className="font-semibold text-slate-200">
                      {acc.sent_today} / {acc.daily_limit || 450} emails
                    </span>
                  </div>
                  <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        usagePercent > 85 ? 'bg-amber-500' : 'bg-indigo-500'
                      }`}
                      style={{ width: `${usagePercent}%` }}
                    />
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-slate-500 mt-1.5">
                    <span>Reset Date: {acc.last_reset_date || 'Today'}</span>
                    <button
                      onClick={() => handleResetQuota(acc.id)}
                      className="text-indigo-400 hover:underline"
                    >
                      Reset Daily Count
                    </button>
                  </div>
                </div>

                {/* Passcode preview & Port */}
                <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                  <span>Passcode: <code className="text-slate-400">{acc.masked_password}</code></span>
                  <span>Port: {acc.port} ({acc.secure ? 'SSL' : 'TLS'})</span>
                </div>

                {/* Live Test Feedback */}
                {testResult[acc.id] && (
                  <div className={`p-2 rounded-lg text-xs flex items-start gap-1.5 ${
                    testResult[acc.id].success 
                      ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/50' 
                      : 'bg-red-950/40 text-red-300 border border-red-800/50'
                  }`}>
                    {testResult[acc.id].success ? (
                      <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-emerald-400" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
                    )}
                    <span>{testResult[acc.id].message}</span>
                  </div>
                )}

                {/* Card Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                  <button
                    onClick={() => handleTestConnection(acc.id)}
                    disabled={testingId === acc.id}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg border border-slate-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${testingId === acc.id ? 'animate-spin' : ''}`} />
                    {testingId === acc.id ? 'Testing...' : 'Test Connection'}
                  </button>

                  <button
                    onClick={() => handleDelete(acc.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800"
                    title="Delete Account"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-lg flex items-center gap-2">
                <Mail className="w-5 h-5 text-indigo-400" />
                Connect Gmail / Google Account
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            {formSuccess && (
              <div className="p-3 bg-emerald-950/60 border border-emerald-800 rounded-xl text-emerald-300 text-xs flex items-start gap-2">
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
                <span>{formSuccess}</span>
              </div>
            )}

            <form onSubmit={handleAddAccount} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Account Label / Nickname
                </label>
                <input
                  type="text"
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Parth Personal Gmail or Work SMTP"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Sender display name
                </label>
                <input
                  type="text"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Shown as From name, Excel can override"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white mb-3"
                />
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Gmail Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="yourname@gmail.com"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  16-Digit Google App Password
                </label>
                <input
                  type="password"
                  required
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  placeholder="abcd efgh ijkl mnop"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Generated from <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-indigo-400 underline">Google App Passwords</a>. Do not enter your regular login password.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                    Port & Security
                  </label>
                  <select
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="465">Port 465 (SSL - Recommended)</option>
                    <option value="587">Port 587 (STARTTLS)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                    Daily Safety Cap (Max 500)
                  </label>
                  <input
                    type="number"
                    max="500"
                    min="10"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formLoading}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center gap-2 shadow-lg shadow-indigo-600/30"
                >
                  {formLoading ? 'Verifying with Google...' : 'Verify & Connect Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

