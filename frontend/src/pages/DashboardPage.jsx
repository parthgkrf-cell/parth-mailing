import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { 
  Send, Calendar, FileText, ShieldCheck, Mail, CheckCircle, 
  AlertTriangle, Users, ArrowUpRight, Clock, PlusCircle
} from 'lucide-react';

export default function DashboardPage({ setActiveTab }) {
  const { isMaster } = useAuth();
  const [stats, setStats] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [recentSchedules, setRecentSchedules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboardData();
    const timer = setInterval(loadDashboardData, 8000);
    return () => clearInterval(timer);
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const [statsRes, accRes, schedRes] = await Promise.all([
        api.getStats(),
        api.getAccounts(),
        api.getSchedules()
      ]);
      setStats(statsRes);
      setAccounts(accRes.accounts || []);
      setRecentSchedules((schedRes.schedules || []).slice(0, 5));
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    } finally {
      setLoading(false);
    }
  };

  const quotaPercent = stats && stats.totalDailyQuota > 0
    ? Math.min(100, Math.round((stats.totalSentToday / stats.totalDailyQuota) * 100))
    : 0;

  return (
    <div className="space-y-8">
      {/* Top Welcome Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-indigo-950/60 via-slate-900 to-slate-900 p-6 rounded-2xl border border-indigo-500/20 shadow-xl">
        <div>
          <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Google Gmail Policy Compliance Engine: Active
          </div>
          <h2 className="text-2xl font-bold text-white">Parth mailing Command Center</h2>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Safely schedule, draft, and dispatch emails across multiple Gmail accounts using 16-digit Google App Passwords without ever breaching Google's daily sending quotas or triggering spam detection.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveTab('compose')}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-xl flex items-center gap-2 shadow-lg shadow-indigo-600/30 transition-all"
          >
            <Send className="w-4 h-4" />
            New Email Campaign
          </button>
          {isMaster && (
            <button
              onClick={() => setActiveTab('accounts')}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl flex items-center gap-2 border border-slate-700 transition-all"
            >
              <PlusCircle className="w-4 h-4 text-emerald-400" />
              Add Gmail Account
            </button>
          )}
        </div>
      </div>

      {/* 4 Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Sent Today */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
            <span>Sent Today</span>
            <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400">
              <Send className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-white">
            {stats ? stats.totalSentToday : 0}
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Pool Quota Used</span>
              <span>{quotaPercent}% ({stats ? stats.totalDailyQuota - stats.totalSentToday : 0} left)</span>
            </div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${
                  quotaPercent > 80 ? 'bg-amber-500' : 'bg-indigo-500'
                }`}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Multi-Accounts */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
            <span>Connected Gmail Accounts</span>
            <div className="p-2 bg-emerald-500/10 rounded-lg text-emerald-400">
              <Mail className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-white">
            {accounts.length}
          </div>
          <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1 font-medium">
            <CheckCircle className="w-3.5 h-3.5" />
            {accounts.filter(a => a.is_active).length} Active & Ready to send
          </p>
        </div>

        {/* Scheduled Campaigns */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
            <span>Active Schedules</span>
            <div className="p-2 bg-sky-500/10 rounded-lg text-sky-400">
              <Calendar className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-white">
            {stats ? stats.scheduledCount : 0}
          </div>
          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-sky-400" />
            Queued for automated pacing
          </p>
        </div>

        {/* Saved Drafts */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium uppercase tracking-wider mb-2">
            <span>Saved Drafts</span>
            <div className="p-2 bg-purple-500/10 rounded-lg text-purple-400">
              <FileText className="w-4 h-4" />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-white">
            {stats ? stats.draftsCount : 0}
          </div>
          <button
            onClick={() => setActiveTab('drafts')}
            className="text-xs text-purple-400 hover:text-purple-300 font-medium mt-2 flex items-center gap-1"
          >
            Manage Drafts <ArrowUpRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Google Gmail Policy Safeguard Checklist Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            Google Gmail Policy & Anti-Spam Safeguards
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium">
            100% Policy Protection Enabled
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5 mb-1 text-sm">
              <ShieldCheck className="w-4 h-4 text-indigo-400" />
              500/day Hard Stop Cap
            </div>
            <p className="text-slate-400 leading-relaxed">
              Google strictly limits standard Gmail accounts to 500 emails per 24 hours. Parth Mailing enforces a safety stop at 450 emails/day per account to ensure your Gmail accounts never get temporarily locked or suspended.
            </p>
          </div>

          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5 mb-1 text-sm">
              <Clock className="w-4 h-4 text-sky-400" />
              Anti-Burst Human Pacing
            </div>
            <p className="text-slate-400 leading-relaxed">
              Gmail detects sudden burst blasts as spam. Our scheduler paces every email with an automated 15–30 second interval plus dynamic random jitter, perfectly simulating organic human mailing habits.
            </p>
          </div>

          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5 mb-1 text-sm">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              Multi-Account Load Balancing
            </div>
            <p className="text-slate-400 leading-relaxed">
              Need to send 1,500 emails? Simply connect 4 Gmail accounts using 16-digit Google App Passwords. Parth Mailing automatically rotates sending across accounts to distribute the volume safely.
            </p>
          </div>
        </div>
      </div>

      {/* Two Column Layout: Connected Accounts & Recent Schedules */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Connected Accounts Snapshot */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Mail className="w-4 h-4 text-indigo-400" />
              Connected Accounts Status
            </h3>
            {isMaster && (
              <button
                onClick={() => setActiveTab('accounts')}
                className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1"
              >
                View All <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {accounts.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
              <Mail className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No Gmail accounts connected yet.</p>
              {isMaster && (
                <button
                  onClick={() => setActiveTab('accounts')}
                  className="mt-3 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  Connect Your First Gmail Account
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {accounts.slice(0, 4).map(acc => {
                const usedPercent = Math.round((acc.sent_today / (acc.daily_limit || 450)) * 100);
                return (
                  <div key={acc.id} className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-white">{acc.label}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          acc.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                          acc.status === 'quota_exceeded' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                          'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}>
                          {acc.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{acc.email}</p>
                    </div>

                    <div className="text-right">
                      <div className="text-xs text-slate-300 font-medium">
                        {acc.sent_today} / {acc.daily_limit || 450}
                      </div>
                      <div className="w-24 bg-slate-800 h-1.5 rounded-full mt-1.5 overflow-hidden">
                        <div 
                          className={`h-full ${usedPercent > 80 ? 'bg-amber-500' : 'bg-indigo-500'}`}
                          style={{ width: `${Math.min(100, usedPercent)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Scheduled Jobs */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-white text-base flex items-center gap-2">
              <Calendar className="w-4 h-4 text-sky-400" />
              Upcoming & Active Schedules
            </h3>
            <button
              onClick={() => setActiveTab('schedules')}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1"
            >
              View Queue <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {recentSchedules.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
              <Clock className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No scheduled email campaigns right now.</p>
              <button
                onClick={() => setActiveTab('compose')}
                className="mt-3 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                Schedule an Email
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {recentSchedules.map(job => (
                <div key={job.id} className="p-3.5 bg-slate-950/60 rounded-xl border border-slate-800/80">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-white truncate max-w-[200px]">
                      {job.subject}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                      job.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                      job.status === 'sending' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20 animate-pulse' :
                      job.status === 'paused' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                      'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                    }`}>
                      {job.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
                    <span>Target: {new Date(job.scheduled_for).toLocaleString()}</span>
                    <span>Progress: {job.sent_count}/{job.total_recipients}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

