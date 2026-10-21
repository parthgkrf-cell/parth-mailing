import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useCampaign } from '../context/CampaignContext';
import { PenTool, Plus, Save, Trash2, Calendar } from 'lucide-react';

const MERGE_TAGS = ['{Name}', '{Email}', '{Affiliation}', '{Sender}', '{SenderName}', '{Template}', '{Date}', '{Time}', '{Session}'];

export default function ComposePage({ onScheduled }) {
  const { recipients } = useCampaign();
  const [templates, setTemplates] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [name, setName] = useState('Default Template');
  const [subject, setSubject] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const active = templates.find((item) => String(item.id) === String(activeId));
  const assignedFrom = accounts[0];

  const load = async () => {
    const [tRes, aRes] = await Promise.all([api.getTemplates(), api.getAccounts()]);
    setTemplates(tRes.templates || []);
    setAccounts(aRes.accounts || []);
    if (tRes.templates?.[0] && !activeId) applyTemplate(tRes.templates[0]);
  };

  const applyTemplate = (template) => {
    setActiveId(template.id);
    setName(template.name);
    setSubject(template.subject || '');
    setCc(template.cc || '');
    setBcc(template.bcc || '');
    setBodyHtml(template.body_html || '');
    setShowCc(Boolean(template.cc || template.bcc));
  };

  useEffect(() => {
    load().catch((err) => setError(err.message));
    const soon = new Date(Date.now() + 5 * 60 * 1000);
    setScheduledFor(new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  }, []);

  const insertTag = (tag) => {
    setBodyHtml((current) => `${current}${tag}`);
  };

  const saveTemplate = async () => {
    setError('');
    setStatus('');
    const payload = { name, subject, cc, bcc, body_html: bodyHtml };
    if (activeId) {
      const res = await api.updateTemplate(activeId, payload);
      setTemplates((list) => list.map((item) => (item.id === res.template.id ? res.template : item)));
    } else {
      const res = await api.saveTemplate(payload);
      setTemplates((list) => [...list, res.template]);
      applyTemplate(res.template);
    }
    setStatus('Template saved. Excel Template column can now match this name.');
  };

  const createTemplate = async () => {
    const nextName = window.prompt('New template name', `Template ${templates.length + 1}`);
    if (!nextName) return;
    const res = await api.saveTemplate({ name: nextName, subject: '', body_html: '' });
    setTemplates((list) => [...list, res.template]);
    applyTemplate(res.template);
  };

  const removeTemplate = async () => {
    if (!activeId || !window.confirm('Delete this template?')) return;
    await api.deleteTemplate(activeId);
    const next = templates.filter((item) => item.id !== activeId);
    setTemplates(next);
    if (next[0]) applyTemplate(next[0]);
    else {
      setActiveId('');
      setName('Default Template');
      setSubject('');
      setBodyHtml('');
    }
  };

  const queueCampaign = async () => {
    setError('');
    setStatus('');
    if (!recipients.length) {
      setError('Import Excel first so each row can fetch its template and sender name.');
      return;
    }
    setLoading(true);
    try {
      await saveTemplate();
      await api.createSchedule({
        subject,
        body_html: bodyHtml,
        recipients,
        scheduled_for: scheduledFor,
        smtp_account_id: assignedFrom?.id || null,
        interval_seconds: 15,
        random_jitter: 8
      });
      setStatus(`Queued ${recipients.length} messages. Each row uses its Excel template and sender name.`);
      if (onScheduled) onScheduled();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
        <div className="flex items-center gap-2 text-indigo-300 font-semibold text-sm">
          <PenTool className="w-4 h-4" /> Compose template
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={activeId}
            onChange={(e) => {
              const found = templates.find((item) => String(item.id) === e.target.value);
              if (found) applyTemplate(found);
            }}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs"
          >
            {templates.length === 0 && <option value="">No templates yet</option>}
            {templates.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <button onClick={createTemplate} className="px-2 py-1 bg-slate-800 rounded-lg text-xs flex items-center gap-1"><Plus className="w-3 h-3" /> New</button>
          <button onClick={removeTemplate} className="px-2 py-1 bg-slate-800 rounded-lg text-xs flex items-center gap-1"><Trash2 className="w-3 h-3" /> Delete</button>
        </div>
      </div>

      <div className="divide-y divide-slate-800 text-sm">
        <div className="px-4 py-2 flex gap-3 items-center">
          <span className="w-20 text-slate-500">From</span>
          <div className="text-slate-200">
            {assignedFrom
              ? `${assignedFrom.from_name || assignedFrom.label} <${assignedFrom.email}>`
              : 'No sending account assigned. Ask Master Admin.'}
            <div className="text-[11px] text-slate-500">Excel Sender Name overrides this per recipient.</div>
          </div>
        </div>
        <div className="px-4 py-2 flex gap-3 items-center">
          <span className="w-20 text-slate-500">Template</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="flex-1 bg-transparent outline-none" />
        </div>
        <div className="px-4 py-2 flex gap-3 items-center">
          <span className="w-20 text-slate-500">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="flex-1 bg-transparent outline-none" placeholder="Subject with {Name}" />
          <button type="button" onClick={() => setShowCc((v) => !v)} className="text-indigo-400 text-xs">Cc/Bcc</button>
        </div>
        {showCc && (
          <>
            <div className="px-4 py-2 flex gap-3"><span className="w-20 text-slate-500">Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} className="flex-1 bg-transparent outline-none" /></div>
            <div className="px-4 py-2 flex gap-3"><span className="w-20 text-slate-500">Bcc</span><input value={bcc} onChange={(e) => setBcc(e.target.value)} className="flex-1 bg-transparent outline-none" /></div>
          </>
        )}
      </div>

      <textarea
        value={bodyHtml}
        onChange={(e) => setBodyHtml(e.target.value)}
        rows={14}
        className="w-full bg-slate-950 px-4 py-3 text-sm outline-none font-mono"
        placeholder="Write HTML or plain text. Insert {Name}, {Sender}, {Affiliation}…"
      />

      <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap gap-2">
        {MERGE_TAGS.map((tag) => (
          <button key={tag} type="button" onClick={() => insertTag(tag)} className="px-2 py-1 bg-slate-800 rounded text-[11px] text-indigo-300">{tag}</button>
        ))}
      </div>

      <div className="px-4 py-4 border-t border-slate-800 flex flex-wrap gap-3 items-center">
        <button onClick={() => saveTemplate().catch((err) => setError(err.message))} className="px-4 py-2 bg-slate-800 rounded-xl text-sm font-semibold flex items-center gap-1">
          <Save className="w-4 h-4" /> Save template
        </button>
        <label className="text-xs text-slate-400">
          Queue at
          <input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} className="ml-2 bg-slate-950 border border-slate-700 rounded px-2 py-1" />
        </label>
        <button disabled={loading} onClick={queueCampaign} className="px-4 py-2 bg-indigo-600 rounded-xl text-sm font-semibold flex items-center gap-1">
          <Calendar className="w-4 h-4" /> Queue campaign
        </button>
        <span className="text-xs text-slate-500 ml-auto">{recipients.length} Excel rows ready</span>
      </div>
      {status && <p className="px-4 pb-4 text-emerald-400 text-sm">{status}</p>}
      {error && <p className="px-4 pb-4 text-red-400 text-sm">{error}</p>}
    </div>
  );
}
