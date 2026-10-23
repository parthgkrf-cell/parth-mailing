import React, { useEffect, useMemo, useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { api } from '../api';
import { Eye } from 'lucide-react';

function sanitizePreviewHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, '');
}

export default function PreviewPage() {
  const { recipients } = useCampaign();
  const [templates, setTemplates] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [recipientId, setRecipientId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [merged, setMerged] = useState(null);

  useEffect(() => {
    let stop = false;
    const pull = () => {
      api.getTemplates().then((res) => { if (!stop) setTemplates(res.templates || []); }).catch(() => {});
      api.getAccounts().then((res) => { if (!stop) setAccounts(res.accounts || []); }).catch(() => {});
    };
    pull();
    const timer = setInterval(pull, 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (recipients[0] && !recipientId) setRecipientId(recipients[0].id);
  }, [recipients, recipientId]);

  const recipient = useMemo(
    () => recipients.find((row) => row.id === recipientId) || recipients[0],
    [recipients, recipientId]
  );

  const selectedTemplate = useMemo(() => {
    if (templateId) return templates.find((item) => String(item.id) === String(templateId));
    const wanted = String(recipient?.template || '').trim().toLowerCase();
    if (!wanted) return null;
    return templates.find((item) => String(item.name).toLowerCase() === wanted) || null;
  }, [templates, templateId, recipient]);

  useEffect(() => {
    if (!recipient || !selectedTemplate) {
      setMerged(null);
      return;
    }
    let stop = false;
    api.previewMerge({
      subject: selectedTemplate.subject,
      body_html: selectedTemplate.body_html,
      recipient
    }).then((res) => { if (!stop) setMerged(res); }).catch(() => {
      if (!stop) {
        setMerged({
          subject: selectedTemplate.subject,
          html: selectedTemplate.body_html,
          from_name: recipient.sender_name
        });
      }
    });
    return () => { stop = true; };
  }, [recipient, selectedTemplate]);

  const account = accounts.find((item) =>
    String(item.email).toLowerCase() === String(recipient?.sender || '').toLowerCase()
    || String(item.label).toLowerCase() === String(recipient?.sender || '').toLowerCase()
  );
  const fromName = recipient?.sender_name || merged?.from_name || account?.from_name || account?.label || 'Unassigned sender';
  const fromEmail = account?.email || recipient?.sender || '';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-950/60">
        <div className="flex items-center gap-2 text-indigo-300 font-semibold text-sm">
          <Eye className="w-4 h-4" /> Preview
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={recipientId}
            onChange={(e) => setRecipientId(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 max-w-[280px]"
          >
            {recipients.length === 0 && <option value="">Import Excel first</option>}
            {recipients.map((row) => (
              <option key={row.id} value={row.id}>{row.name || row.email} — {row.email}</option>
            ))}
          </select>
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100"
          >
            <option value="">Auto from Excel</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>

      {!recipient ? (
        <div className="min-h-[36rem] flex items-center justify-center text-slate-300 text-sm px-6 text-center">
          Import an Excel sheet, then pick a recipient. This window matches the Composer size.
        </div>
      ) : (
        <>
          <div className="divide-y divide-slate-800 text-sm">
            <div className="px-4 py-2 flex gap-3">
              <span className="w-24 text-slate-300 font-semibold">From</span>
              <span className="text-slate-100">{fromName}{fromEmail ? ` <${fromEmail}>` : ''}</span>
            </div>
            <div className="px-4 py-2 flex gap-3">
              <span className="w-24 text-slate-300 font-semibold">To</span>
              <span className="text-slate-100">{recipient.name ? `${recipient.name} ` : ''}&lt;{recipient.email}&gt;</span>
            </div>
            <div className="px-4 py-2 flex gap-3">
              <span className="w-24 text-slate-300 font-semibold">Template</span>
              <span className="text-slate-100">
                {selectedTemplate?.name || recipient.template || '—'}
                {recipient.template && !selectedTemplate ? ' (no saved template with this name)' : ''}
              </span>
            </div>
            <div className="px-4 py-2 flex gap-3">
              <span className="w-24 text-slate-300 font-semibold">Subject</span>
              <strong className="text-white">{merged?.subject || selectedTemplate?.subject || '(No subject)'}</strong>
            </div>
          </div>
          <div
            className="bg-white text-slate-900 min-h-[28rem] p-6 text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: sanitizePreviewHtml(merged?.html) || '<p style="color:#64748b">Empty message</p>' }}
          />
        </>
      )}
    </div>
  );
}
