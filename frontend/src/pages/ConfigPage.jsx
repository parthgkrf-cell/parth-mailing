import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { Link2, Copy, CheckCircle } from 'lucide-react';

export default function ConfigPage() {
  const { isMaster } = useAuth();
  const [tracking, setTracking] = useState({
    enabled: true,
    source: 'ParthMailing',
    medium: 'email',
    campaign: '101',
    content: '',
    sampleUrl: 'https://example.com/cfp.php#section06'
  });
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState('');
  const trackingRef = useRef(tracking);

  const updateTracking = (next) => {
    trackingRef.current = next;
    setTracking(next);
  };

  const refresh = async () => {
    const res = await api.getGa4();
    updateTracking(res.tracking);
    setPreview(res.preview);
  };

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, []);

  const save = async (next) => {
    if (!isMaster) {
      setStatus('Only Master Admin can change GA4 tracking.');
      return;
    }
    const payload = next || trackingRef.current;
    updateTracking(payload);
    const res = await api.saveGa4(payload);
    updateTracking(res.tracking);
    setPreview(res.preview);
    setStatus('GA4 tags saved. They are added to website links when a message is sent.');
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6">
        <h2 className="text-xl font-bold text-white flex items-center gap-2 mb-2">
          <Link2 className="w-5 h-5 text-indigo-400" />
          GA4 email tracker
        </h2>
        <p className="text-sm text-slate-400 mb-4">
          GA4 only reads tags that come before the <code className="text-slate-200">#</code>.
          A link like <code className="text-slate-200">cfp.php#section06?utm_source=mail</code> is counted as direct traffic.
        </p>

        <label className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-4">
          <input
            type="checkbox"
            checked={tracking.enabled}
            disabled={!isMaster}
            onChange={(e) => {
              const next = { ...trackingRef.current, enabled: e.target.checked };
              updateTracking(next);
              save(next);
            }}
          />
          Add these tags to every website link when an email is sent
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            ['source', 'Source'],
            ['medium', 'Medium'],
            ['campaign', 'Campaign'],
            ['content', 'Content (optional)']
          ].map(([key, label]) => (
            <label key={key} className="text-xs text-slate-400 font-semibold">
              {label}
              <input
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
                value={tracking[key] || ''}
                disabled={!isMaster}
                onChange={(e) => updateTracking({ ...trackingRef.current, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>

        <label className="block text-xs text-slate-400 font-semibold mt-4">
          Link to track
          <input
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
            value={tracking.sampleUrl || ''}
            disabled={!isMaster}
            onChange={(e) => updateTracking({ ...trackingRef.current, sampleUrl: e.target.value })}
          />
        </label>

        <div className="flex flex-wrap gap-2 mt-4">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(preview);
              setStatus('Tracked link copied.');
            }}
            className="px-3 py-2 bg-indigo-600 text-white text-xs font-semibold rounded-lg flex items-center gap-1"
          >
            <Copy className="w-3.5 h-3.5" /> Copy tracked link
          </button>
          {isMaster && (
            <button
              type="button"
              onClick={() => save().catch((err) => setStatus(err.message))}
              className="px-3 py-2 bg-slate-800 text-slate-200 text-xs font-semibold rounded-lg"
            >
              Save tracker for outgoing mail
            </button>
          )}
        </div>

        <code className="block mt-4 text-xs break-all bg-slate-950 border border-slate-800 rounded-lg p-3 text-emerald-300">{preview}</code>
        {status && (
          <p className={`text-xs mt-3 flex items-center gap-1 ${status.toLowerCase().includes('only master') || status.toLowerCase().includes('fail') ? 'text-red-400' : 'text-emerald-400'}`}>
            <CheckCircle className="w-3.5 h-3.5" /> {status}
          </p>
        )}
        <p className="text-xs text-slate-500 mt-4">
          In GA4 open Reports → Acquisition → Traffic acquisition and set Session source / medium.
          Email visits show as {String(tracking.source || 'parthmailing').toLowerCase()} / {tracking.medium || 'email'}.
        </p>
      </div>
    </div>
  );
}
