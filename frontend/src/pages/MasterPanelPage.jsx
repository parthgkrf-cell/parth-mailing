import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { 
  ShieldCheck, Users, Sliders, Mail, ListFilter, CheckCircle, 
  AlertTriangle, RefreshCw, Trash2, Power, UserCheck, Settings, Save, Lock
} from 'lucide-react';

export default function MasterPanelPage() {
  const { isMaster } = useAuth();
  const [subTab, setSubTab] = useState('users'); // 'users', 'policy', 'fleet', 'logs'
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [settings, setSettings] = useState({});
  const [fleetAccounts, setFleetAccounts] = useState([]);
  const [globalLogs, setGlobalLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Policy form state
  const [appName, setAppName] = useState('');
  const [gmailMaxDaily, setGmailMaxDaily] = useState('450');
  const [minInterval, setMinInterval] = useState('15');
  const [defaultJitter, setDefaultJitter] = useState('10');
  const [requireApproval, setRequireApproval] = useState('0');
  const [enforceUnsub, setEnforceUnsub] = useState('1');
  const [syncEnabled, setSyncEnabled] = useState('0');
  const [syncUrl, setSyncUrl] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [testingAll, setTestingAll] = useState(false);
  const [testReport, setTestReport] = useState(null);
  const [assignUser, setAssignUser] = useState(null);
  const [assignableAccounts, setAssignableAccounts] = useState([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState([]);

  useEffect(() => {
    if (!isMaster) return;
    loadMasterData();
  }, [subTab, isMaster]);

  useEffect(() => {
    if (!isMaster || subTab !== 'fleet') return undefined;
    const timer = setInterval(() => {
      api.getMasterAccounts()
        .then((res) => setFleetAccounts(res.accounts || []))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [isMaster, subTab]);

  const loadMasterData = async () => {
    try {
      setLoading(true);
      const [statsRes, settingsRes] = await Promise.all([
        api.getMasterStats(),
        api.getMasterSettings()
      ]);
      setStats(statsRes);
      setSettings(settingsRes.settings || {});

      // populate settings form
      if (settingsRes.settings) {
        setAppName(settingsRes.settings.app_name || 'Parth mailing');
        setGmailMaxDaily(settingsRes.settings.gmail_max_daily_limit || '450');
        setMinInterval(settingsRes.settings.min_interval_seconds || '15');
        setDefaultJitter(settingsRes.settings.default_jitter_seconds || '10');
        setRequireApproval(settingsRes.settings.require_user_approval || '0');
        setEnforceUnsub(settingsRes.settings.enforce_unsubscribe_header || '1');
        setSyncEnabled(settingsRes.settings.accounts_sync_enabled || '0');
        setSyncUrl(settingsRes.settings.accounts_sync_url || '');
      }

      if (subTab === 'users') {
        const uRes = await api.getMasterUsers();
        setUsers(uRes.users || []);
      } else if (subTab === 'fleet') {
        const aRes = await api.getMasterAccounts();
        setFleetAccounts(aRes.accounts || []);
      } else if (subTab === 'logs') {
        const lRes = await api.getMasterLogs(150);
        setGlobalLogs(lRes.logs || []);
      }
    } catch (err) {
      console.error('Master load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleUserStatus = async (user) => {
    try {
      await api.toggleUserStatus(user.id);
      loadMasterData();
    } catch (err) {
      alert(err.message || 'Failed to update user');
    }
  };

  const handleApproveUser = async (id) => {
    try {
      await api.approveUser(id);
      loadMasterData();
    } catch (err) {
      alert(err.message || 'Failed to approve user');
    }
  };

  const handleChangeRole = async (id, currentRole) => {
    const newRole = currentRole === 'master' ? 'user' : 'master';
    if (!window.confirm(`Change role to ${newRole.toUpperCase()}?`)) return;
    try {
      await api.changeUserRole(id, newRole);
      loadMasterData();
    } catch (err) {
      alert(err.message || 'Failed to change role');
    }
  };

  const openAssign = async (user) => {
    try {
      const res = await api.getUserAccounts(user.id);
      setAssignUser(user);
      setAssignableAccounts(res.accounts || []);
      setSelectedAccountIds(res.account_ids || []);
    } catch (err) {
      alert(err.message || 'Failed to load assignments');
    }
  };

  const saveAssign = async () => {
    if (!assignUser) return;
    try {
      await api.assignUserAccounts(assignUser.id, selectedAccountIds);
      setAssignUser(null);
      loadMasterData();
    } catch (err) {
      alert(err.message || 'Failed to assign accounts');
    }
  };

  const handleDeleteUser = async (id) => {
    if (!window.confirm('Are you sure? This will delete the user and all their connected accounts, drafts, and schedules!')) return;
    try {
      await api.deleteUser(id);
      loadMasterData();
    } catch (err) {
      alert(err.message || 'Failed to delete user');
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsStatus('');
    try {
      await api.updateMasterSettings({
        app_name: appName,
        gmail_max_daily_limit: gmailMaxDaily,
        min_interval_seconds: minInterval,
        default_jitter_seconds: defaultJitter,
        require_user_approval: requireApproval,
        enforce_unsubscribe_header: enforceUnsub,
        accounts_sync_enabled: syncEnabled,
        accounts_sync_url: syncUrl
      });
      setSettingsStatus('Settings and global policies updated successfully!');
      setTimeout(() => setSettingsStatus(''), 3000);
    } catch (err) {
      setSettingsStatus(`Error: ${err.message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    setTestReport(null);
    try {
      const res = await api.testAllAccounts();
      setTestReport(res);
      const fleet = await api.getMasterAccounts();
      setFleetAccounts(fleet.accounts || []);
    } catch (err) {
      setTestReport({ error: err.message || 'Mailbox test failed.' });
    } finally {
      setTestingAll(false);
    }
  };

  const handleFetchSync = async () => {
    setSettingsStatus('');
    try {
      await api.updateMasterSettings({
        accounts_sync_enabled: '1',
        accounts_sync_url: syncUrl
      });
      setSyncEnabled('1');
      const res = await api.syncAccountsNow();
      setSettingsStatus(res.warning ? `${res.message} ${res.warning}` : res.message);
      loadMasterData();
    } catch (err) {
      setSettingsStatus(`Error: ${err.message}`);
    }
  };

  if (!isMaster) return null;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Master Top Header */}
      <div className="bg-gradient-to-r from-purple-950/80 via-slate-900 to-indigo-950/60 p-6 rounded-2xl border border-purple-500/30 shadow-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-purple-400 text-xs font-bold uppercase tracking-wider mb-1">
            <Lock className="w-4 h-4 text-purple-400" />
            Parth's Master Control Dashboard
          </div>
          <h2 className="text-2xl font-black text-white">System Governance & Master Settings</h2>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            You hold master privileges. Control user access, calibrate platform-wide Google Gmail compliance policies, inspect connected account fleets, and oversee email queues.
          </p>
        </div>

        <button
          onClick={loadMasterData}
          className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-colors self-end md:self-auto"
          title="Refresh Master Data"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Global Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Total Users</div>
          <div className="text-2xl font-bold text-white">{stats ? stats.totalUsers : 0}</div>
          {stats && stats.pendingUsers > 0 && (
            <span className="text-[11px] text-amber-400 font-semibold">
              {stats.pendingUsers} pending approval
            </span>
          )}
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Connected Accounts</div>
          <div className="text-2xl font-bold text-white">{stats ? stats.totalAccounts : 0}</div>
          <span className="text-[11px] text-emerald-400 font-medium">
            {stats ? stats.activeAccounts : 0} active in fleet
          </span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Total Dispatched</div>
          <div className="text-2xl font-bold text-emerald-400">{stats ? stats.totalSent : 0}</div>
          <span className="text-[11px] text-slate-400">
            {stats ? stats.sentTodayAll : 0} sent today platform-wide
          </span>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">Active Queue</div>
          <div className="text-2xl font-bold text-sky-400">{stats ? stats.scheduledActive : 0}</div>
          <span className="text-[11px] text-slate-400">Scheduled campaigns</span>
        </div>
      </div>

      {/* Sub Tabs */}
      <div className="flex bg-slate-900 p-1.5 rounded-2xl border border-slate-800 overflow-x-auto">
        <button
          onClick={() => setSubTab('users')}
          className={`flex-1 min-w-[120px] py-2 text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all ${
            subTab === 'users' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Users className="w-4 h-4" />
          User Management ({users.length})
        </button>

        <button
          onClick={() => setSubTab('policy')}
          className={`flex-1 min-w-[120px] py-2 text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all ${
            subTab === 'policy' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Sliders className="w-4 h-4" />
          Gmail Policy & App Settings
        </button>

        <button
          onClick={() => setSubTab('fleet')}
          className={`flex-1 min-w-[120px] py-2 text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all ${
            subTab === 'fleet' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Mail className="w-4 h-4" />
          All Connected Accounts ({stats ? stats.totalAccounts : fleetAccounts.length})
        </button>

        <button
          onClick={() => setSubTab('logs')}
          className={`flex-1 min-w-[120px] py-2 text-xs font-bold rounded-xl flex items-center justify-center gap-2 transition-all ${
            subTab === 'logs' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
          }`}
        >
          <ListFilter className="w-4 h-4" />
          Global Mail Logs
        </button>
      </div>

      {/* Tab 1: User Management */}
      {subTab === 'users' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h3 className="font-bold text-white text-sm">Registered WebApp Users</h3>
            <span className="text-xs text-slate-400">Total: {users.length}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                <tr>
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Approval</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Accounts</th>
                  <th className="py-3 px-4">Emails Sent</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-bold text-white">{u.name}</div>
                      <div className="text-slate-400 text-[11px] font-mono">{u.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => handleChangeRole(u.id, u.role)}
                        className={`px-2 py-0.5 rounded-full font-bold text-[10px] transition-colors ${
                          u.role === 'master' 
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' 
                            : 'bg-slate-800 text-slate-400 hover:text-white'
                        }`}
                        title="Click to toggle Master / User role"
                      >
                        {u.role.toUpperCase()}
                      </button>
                    </td>
                    <td className="py-3 px-4">
                      {u.is_approved ? (
                        <span className="text-emerald-400 flex items-center gap-1 font-medium">
                          <CheckCircle className="w-3.5 h-3.5" /> Approved
                        </span>
                      ) : (
                        <button
                          onClick={() => handleApproveUser(u.id)}
                          className="px-2 py-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-lg text-[10px] font-bold flex items-center gap-1"
                        >
                          <UserCheck className="w-3.5 h-3.5" /> Approve Now
                        </button>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => handleToggleUserStatus(u)}
                        className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${
                          u.is_active 
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}
                        title="Click to toggle Active / Banned"
                      >
                        {u.is_active ? 'Active' : 'Suspended'}
                      </button>
                    </td>
                    <td className="py-3 px-4 text-slate-300">{u.assigned_accounts_count || 0} assigned</td>
                    <td className="py-3 px-4 text-slate-300">{u.emails_sent_count} sent</td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex justify-end gap-1">
                        {u.role !== 'master' && (
                          <button
                            onClick={() => openAssign(u)}
                            className="px-2 py-1 text-[10px] font-bold bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded-lg"
                          >
                            Assign mailboxes
                          </button>
                        )}
                        {u.role !== 'master' && (
                          <button
                            onClick={() => handleDeleteUser(u.id)}
                            className="p-1.5 text-slate-400 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800"
                            title="Delete User"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Gmail Policy & App Settings */}
      {subTab === 'policy' && (
        <form onSubmit={handleSaveSettings} className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
          <div>
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Settings className="w-5 h-5 text-indigo-400" />
              Master Policy & Gmail Safeguards Configuration
            </h3>
            <p className="text-slate-400 text-xs mt-1">
              Any change made here immediately applies platform-wide to protect all connected Google accounts from spam restrictions.
            </p>
          </div>

            {settingsStatus && (
            <div className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
              settingsStatus.startsWith('Error') 
                ? 'bg-red-950/60 border border-red-800 text-red-300' 
                : 'bg-emerald-950/60 border border-emerald-800 text-emerald-300'
            }`}>
              {settingsStatus.startsWith('Error') ? (
                <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
              ) : (
                <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400" />
              )}
              <span>{settingsStatus}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            {/* App Branding */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Application Branding Name
              </label>
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">Default: Parth mailing</p>
            </div>

            {/* Daily Safety Cap */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Gmail Max Daily Limit Cap (Hard Stop)
              </label>
              <input
                type="number"
                max="500"
                min="50"
                value={gmailMaxDaily}
                onChange={(e) => setGmailMaxDaily(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Google sets a hard 500 ceiling for free Gmail. Recommended safety limit is 400–450.
              </p>
            </div>

            {/* Minimum Interval Pacing */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Minimum Delay Between Sends (Seconds)
              </label>
              <input
                type="number"
                min="5"
                max="120"
                value={minInterval}
                onChange={(e) => setMinInterval(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Pacing delay between each sent email. Prevents burst rate triggering Google 5.7.0 spam errors.
              </p>
            </div>

            {/* Random Human Jitter */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Random Human Jitter (Seconds)
              </label>
              <input
                type="number"
                min="1"
                max="30"
                value={defaultJitter}
                onChange={(e) => setDefaultJitter(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Adds a dynamic 0 to N second variable delay to randomize intervals like a human sender.
              </p>
            </div>

            {/* Require Master Approval */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                New User Registration Policy
              </label>
              <select
                value={requireApproval}
                onChange={(e) => setRequireApproval(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="0">Instant Access (Newly registered users can log in immediately)</option>
                <option value="1">Strict Access (Requires Master Admin to manually approve before login)</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Live mailbox file (Google Drive or GitHub)
              </label>
              <select
                value={syncEnabled}
                onChange={(e) => setSyncEnabled(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mb-2"
              >
                <option value="0">Off — mailboxes stay as saved in this app</option>
                <option value="1">On — every user and admin refreshes from the link below</option>
              </select>
              <input
                type="url"
                value={syncUrl}
                onChange={(e) => setSyncUrl(e.target.value)}
                placeholder="https://drive.google.com/file/d/… or a GitHub raw link"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Put the mailbox JSON on Drive (share as anyone with the link) or in a private GitHub file. Do not commit passwords to a public repository. The sample shape is in config/accounts.sync.example.json. Changes show up for every signed-in person within a few seconds.
              </p>
              {settings.accounts_sync_status && (
                <p className="text-[11px] text-slate-200 mt-2">
                  Last fetch{settings.accounts_sync_checked_at ? ` (${new Date(settings.accounts_sync_checked_at).toLocaleString()})` : ''}: {settings.accounts_sync_status}
                </p>
              )}
              <button
                type="button"
                onClick={handleFetchSync}
                className="mt-2 px-3 py-1.5 bg-slate-800 text-slate-100 text-xs font-semibold rounded-lg"
              >
                Save link and fetch now
              </button>
            </div>

            {/* Google 2024 Unsubscribe Header */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Google 2024 Bulk Sender RFC List-Unsubscribe Header
              </label>
              <select
                value={enforceUnsub}
                onChange={(e) => setEnforceUnsub(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="1">Enforced (Always inject List-Unsubscribe & One-Click headers)</option>
                <option value="0">Optional</option>
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800 flex justify-end">
            <button
              type="submit"
              disabled={savingSettings}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm flex items-center gap-2 shadow-lg shadow-indigo-600/30 transition-all"
            >
              <Save className="w-4 h-4" />
              {savingSettings ? 'Saving Settings...' : 'Save Global Master Rules'}
            </button>
          </div>
        </form>
      )}

      {/* Tab 3: Fleet Accounts */}
      {subTab === 'fleet' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-white text-sm">Fleet-wide Connected Google Accounts</h3>
              <p className="text-[11px] text-slate-300 mt-1">Super Admin check. Each mailbox is signed in over SMTP. A failure includes the reason.</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">Total: {fleetAccounts.length}</span>
              <button
                type="button"
                onClick={handleTestAll}
                disabled={testingAll}
                className="px-3 py-1.5 bg-indigo-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg"
              >
                {testingAll ? 'Testing mailboxes…' : 'Test all mailboxes'}
              </button>
            </div>
          </div>
          {testReport && (
            <div className="px-4 py-3 border-b border-slate-800 space-y-2">
              {testReport.error ? (
                <p className="text-sm text-red-300">{testReport.error}</p>
              ) : (
                <>
                  <p className="text-sm text-slate-100">{testReport.working} working, {testReport.failing} not working, of {testReport.tested} tested.</p>
                  <div className="space-y-1">
                    {(testReport.results || []).map((item) => (
                      <div key={item.id} className={`text-xs rounded-lg px-3 py-2 ${item.working ? 'bg-emerald-950/40 text-emerald-200' : 'bg-red-950/40 text-red-200'}`}>
                        <span className="font-semibold">{item.label}</span> <span className="font-mono">{item.email}</span>
                        <div>{item.working ? 'Working' : 'Not working'}: {item.reason}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                <tr>
                  <th className="py-3 px-4">Owner</th>
                  <th className="py-3 px-4">Account Label</th>
                  <th className="py-3 px-4">Gmail Address</th>
                  <th className="py-3 px-4">Today's Usage</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Port / Security</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {fleetAccounts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-bold text-white">{a.owner_name}</div>
                      <div className="text-[11px] text-slate-400">{a.owner_email}</div>
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-200">{a.label}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">{a.email}</td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-white">{a.sent_today}</span> / {a.daily_limit}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${
                        a.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                        a.status === 'quota_exceeded' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                        'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}>
                        {a.status}
                      </span>
                      {a.error_message && (
                        <div className="text-[10px] text-red-300 mt-1 max-w-[240px]">{a.error_message}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400">{a.port} ({a.secure ? 'SSL' : 'TLS'})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 4: Global Logs */}
      {subTab === 'logs' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between">
            <h3 className="font-bold text-white text-sm">System-Wide Audit Stream</h3>
            <span className="text-xs text-slate-400">Showing last {globalLogs.length} events</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                <tr>
                  <th className="py-3 px-4">Time</th>
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">From (Gmail)</th>
                  <th className="py-3 px-4">To (Recipient)</th>
                  <th className="py-3 px-4">Subject</th>
                  <th className="py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {globalLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(l.sent_at).toLocaleTimeString()}
                    </td>
                    <td className="py-3 px-4 font-medium text-white">{l.user_name}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">{l.sender_email || '—'}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">{l.recipient}</td>
                    <td className="py-3 px-4 text-slate-300 max-w-xs truncate">{l.subject}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full font-medium text-[10px] ${
                        l.status === 'sent' 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}>
                        {l.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {assignUser && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-5">
            <h3 className="font-bold text-white mb-1">Assign sending accounts</h3>
            <p className="text-xs text-slate-400 mb-4">
              {assignUser.name} can only send with the mailboxes you tick here.
            </p>
            <div className="max-h-72 overflow-y-auto space-y-2">
              {assignableAccounts.length === 0 && (
                <p className="text-sm text-slate-500">Add SMTP accounts in Sending Accounts first.</p>
              )}
              {assignableAccounts.map((account) => (
                <label key={account.id} className="flex items-start gap-2 text-sm bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.includes(account.id)}
                    onChange={(e) => {
                      setSelectedAccountIds((ids) =>
                        e.target.checked ? [...ids, account.id] : ids.filter((id) => id !== account.id)
                      );
                    }}
                  />
                  <span>
                    <span className="text-white font-semibold">{account.from_name || account.label}</span>
                    <span className="block text-xs text-slate-400 font-mono">{account.email}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setAssignUser(null)} className="px-3 py-2 text-xs bg-slate-800 rounded-lg">Cancel</button>
              <button onClick={saveAssign} className="px-3 py-2 text-xs bg-indigo-600 rounded-lg font-semibold">Save assignment</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

