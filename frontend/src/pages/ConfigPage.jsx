import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Link2, Copy, CheckCircle } from 'lucide-react';

export default function ConfigPage() {
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

  const refresh = async () => {
    const res = await api.getGa4();
    setTracking(res.tracking);
    setPreview(res.preview);
  };

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, []);

  const save = async (next) => {
    const payload = next || tracking;
    setTracking(payload);
    const res = await api.saveGa4(payload);
    setTracking(res.tracking);
    setPreview(res.preview);
    setStatus('GA4 tags saved.');
  };

  const tagTemplateLinks = async () => {
    const templates = await api.getTemplates();
    const list = templates.templates || [];
    for (const template of list) {
      const tagged = String(template.body_html || '').replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, url) => {
        const taggedUrl = preview && tracking.sampleUrl ? url : url;
        return match.replace(url, taggedUrl);
      });
      if (tagged !== template.body_html) {
        await api.updateTemplate(template.id, { ...template, body_html: tagged });
      }
    }
    const res = await api.saveGa4(tracking);
    setPreview(res.preview);
    setStatus('Current templates will receive these tags on send. Saved tracker.');
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
            onChange={(e) => save({ ...tracking, enabled: e.target.checked })}
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
                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                value={tracking[key] || ''}
                onChange={(e) => setTracking({ ...tracking, [key]: e.target.value })}
                onBlur={() => save(tracking)}
              />
            </label>
          ))}
        </div>

        <label className="block text-xs text-slate-400 font-semibold mt-4">
          Link to track
          <input
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            value={tracking.sampleUrl || ''}
            onChange={(e) => setTracking({ ...tracking, sampleUrl: e.target.value })}
            onBlur={() => save(tracking)}
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
          <button
            type="button"
            onClick={() => tagTemplateLinks().catch((err) => setStatus(err.message))}
            className="px-3 py-2 bg-slate-800 text-slate-200 text-xs font-semibold rounded-lg"
          >
            Save tracker for outgoing mail
          </button>
        </div>

        <code className="block mt-4 text-xs break-all bg-slate-950 border border-slate-800 rounded-lg p-3 text-emerald-300">{preview}</code>
        {status && (
          <p className="text-emerald-400 text-xs mt-3 flex items-center gap-1">
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
