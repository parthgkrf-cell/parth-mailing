import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { 
  Calendar, Pause, Play, Trash2, Clock, CheckCircle, 
  AlertCircle, RefreshCw, Send, ShieldCheck
} from 'lucide-react';

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSchedules();
    const interval = setInterval(loadSchedules, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadSchedules = async () => {
    try {
      const res = await api.getSchedules();
      setSchedules(res.schedules || []);
    } catch (err) {
      console.error('Failed to load schedules:', err);
    } finally {
      setLoading(false);
    }
  };

  const handlePause = async (id) => {
    try {
      await api.pauseSchedule(id);
      loadSchedules();
    } catch (err) {
      alert(err.message || 'Failed to pause');
    }
  };

  const handleResume = async (id) => {
    try {
      await api.resumeSchedule(id);
      loadSchedules();
    } catch (err) {
      alert(err.message || 'Failed to resume');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to cancel and delete this schedule?')) return;
    try {
      await api.deleteSchedule(id);
      loadSchedules();
    } catch (err) {
      alert(err.message || 'Failed to delete');
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Calendar className="w-6 h-6 text-sky-400" />
            Scheduled Campaigns Queue
          </h2>
          <p className="text-slate-400 text-sm">
            Live execution status with automated Google rate limiting and anti-burst delays.
          </p>
        </div>
        <button
          onClick={loadSchedules}
          className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-colors"
          title="Refresh Queue"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {loading && schedules.length === 0 ? (
        <div className="text-center py-12 text-slate-500">Loading schedules...</div>
      ) : schedules.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/60 border border-slate-800 rounded-2xl">
          <Calendar className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-white">No schedules in queue</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1">
            Head to the Compose tab to create your first scheduled email campaign.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {schedules.map((job) => {
            const percent = job.total_recipients > 0
              ? Math.round(((job.sent_count + job.failed_count) / job.total_recipients) * 100)
              : 0;

            return (
              <div
                key={job.id}
                className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className={`px-2.5 py-1 text-xs font-semibold rounded-full flex items-center gap-1.5 ${
                      job.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' :
                      job.status === 'sending' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/30 animate-pulse' :
                      job.status === 'paused' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' :
                      'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30'
                    }`}>
                      {job.status === 'sending' && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />}
                      {job.status.toUpperCase()}
                    </span>
                    <h3 className="text-base font-bold text-white truncate max-w-md">
                      {job.subject}
                    </h3>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    {job.status === 'sending' || job.status === 'scheduled' ? (
                      <button
                        onClick={() => handlePause(job.id)}
                        className="px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 text-xs font-semibold rounded-lg flex items-center gap-1 transition-colors"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        Pause
                      </button>
                    ) : job.status === 'paused' ? (
                      <button
                        onClick={() => handleResume(job.id)}
                        className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold rounded-lg flex items-center gap-1 transition-colors"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Resume
                      </button>
                    ) : null}

                    <button
                      onClick={() => handleDelete(job.id)}
                      className="p-1.5 text-slate-400 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800"
                      title="Cancel & Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                    <span>
                      Processed: <strong className="text-white">{job.sent_count + job.failed_count}</strong> of {job.total_recipients}
                      {job.failed_count > 0 && (
                        <span className="text-red-400 ml-2">({job.failed_count} failed)</span>
                      )}
                    </span>
                    <span>{percent}% Completed</span>
                  </div>
                  <div className="w-full bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className={`h-full transition-all duration-500 rounded-full ${
                        job.status === 'completed' ? 'bg-emerald-500' :
                        job.status === 'paused' ? 'bg-amber-500' : 'bg-sky-500'
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>

                {/* Metadata details */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-xs text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    <span>Scheduled for: {new Date(job.scheduled_for).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Pacing: {job.interval_seconds}s (±{job.random_jitter}s jitter)</span>
                  </div>
                  <div className="flex items-center gap-1.5 sm:justify-end">
                    <span>Sender: {job.account_email || 'Auto-Rotating Active Pool'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

