import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { ListFilter, CheckCircle, AlertCircle, RefreshCw, Mail, Search } from 'lucide-react';

export default function LogsPage() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadLogs();
  }, []);

  const loadLogs = async () => {
    try {
      setLoading(true);
      const res = await api.getLogs(200);
      setLogs(res.logs || []);
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const filteredLogs = logs.filter(l => {
    if (filter === 'sent' && l.status !== 'sent') return false;
    if (filter === 'failed' && l.status !== 'failed') return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        l.recipient.toLowerCase().includes(q) ||
        (l.subject && l.subject.toLowerCase().includes(q)) ||
        (l.sender_email && l.sender_email.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Mail className="w-6 h-6 text-emerald-400" />
            Email Delivery Logs
          </h2>
          <p className="text-slate-400 text-sm">
            Detailed delivery audit trail for every message dispatched through Parth Mailing.
          </p>
        </div>

        <button
          onClick={loadLogs}
          className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-colors self-end sm:self-auto"
          title="Refresh Logs"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/80 p-3 rounded-2xl border border-slate-800">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search recipient, subject..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 w-full sm:w-auto">
          {['all', 'sent', 'failed'].map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`flex-1 sm:flex-initial px-3 py-1 text-xs font-semibold rounded-lg capitalize transition-colors ${
                filter === item ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading delivery logs...</div>
        ) : filteredLogs.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            No logs matching current criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                <tr>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Recipient</th>
                  <th className="py-3 px-4">Subject</th>
                  <th className="py-3 px-4">Sender Account</th>
                  <th className="py-3 px-4">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium text-[10px] ${
                        log.status === 'sent' 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                          : 'bg-red-500/10 text-red-400 border border-red-500/20'
                      }`}>
                        {log.status === 'sent' ? (
                          <CheckCircle className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <AlertCircle className="w-3 h-3 text-red-400" />
                        )}
                        {log.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-200">
                      {log.recipient}
                    </td>
                    <td className="py-3 px-4 text-slate-300 font-medium max-w-xs truncate">
                      {log.subject}
                      {log.error_message && (
                        <div className="text-[10px] text-red-400 mt-0.5 truncate font-normal">
                          {log.error_message}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {log.sender_email || log.account_label || '—'}
                    </td>
                    <td className="py-3 px-4 text-slate-500 whitespace-nowrap">
                      {new Date(log.sent_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

