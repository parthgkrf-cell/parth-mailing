import React, { useEffect, useMemo, useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { api } from '../api';
import { Eye } from 'lucide-react';

export default function PreviewPage() {
  const { recipients } = useCampaign();
  const [templates, setTemplates] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [recipientId, setRecipientId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [merged, setMerged] = useState(null);

  useEffect(() => {
    api.getTemplates().then((res) => setTemplates(res.templates || [])).catch(() => {});
    api.getAccounts().then((res) => setAccounts(res.accounts || [])).catch(() => {});
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
    if (!recipient) return templates[0];
    return templates.find((item) => String(item.name).toLowerCase() === String(recipient.template || '').toLowerCase()) || templates[0];
  }, [templates, templateId, recipient]);

  useEffect(() => {
    if (!recipient || !selectedTemplate) {
      setMerged(null);
      return;
    }
    api.previewMerge({
      subject: selectedTemplate.subject,
      body_html: selectedTemplate.body_html,
      recipient
    }).then(setMerged).catch(() => setMerged({
      subject: selectedTemplate.subject,
      html: selectedTemplate.body_html,
      from_name: recipient.sender_name
    }));
  }, [recipient, selectedTemplate]);

  const account = accounts.find((item) =>
    String(item.email).toLowerCase() === String(recipient?.sender || '').toLowerCase()
    || String(item.label).toLowerCase() === String(recipient?.sender || '').toLowerCase()
  );
  const fromName = recipient?.sender_name || account?.from_name || account?.label || 'Unassigned sender';

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-slate-400 font-semibold">Recipient</label>
          <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm">
            {recipients.length === 0 && <option value="">Import Excel first</option>}
            {recipients.map((row) => (
              <option key={row.id} value={row.id}>{row.name || row.email} — {row.email}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-slate-400 font-semibold">Template</label>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm">
            <option value="">Auto from Excel</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>

      {!recipient ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center text-slate-400">
          Import an Excel sheet, then pick a recipient to preview the campaign.
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2 text-indigo-300 text-sm font-semibold">
            <Eye className="w-4 h-4" /> Live preview
          </div>
          <div className="p-5 space-y-2 text-sm">
            <div><span className="text-slate-500 w-20 inline-block">From</span> {fromName} {account ? `<${account.email}>` : recipient.sender ? `<${recipient.sender}>` : ''}</div>
            <div><span className="text-slate-500 w-20 inline-block">To</span> {recipient.name} &lt;{recipient.email}&gt;</div>
            <div><span className="text-slate-500 w-20 inline-block">Template</span> {selectedTemplate?.name || recipient.template || '—'}</div>
            <div><span className="text-slate-500 w-20 inline-block">Subject</span> <strong>{merged?.subject || selectedTemplate?.subject || '(No subject)'}</strong></div>
          </div>
          <div className="bg-white text-slate-900 min-h-[280px] p-6" dangerouslySetInnerHTML={{ __html: merged?.html || '<p class="text-slate-400">Empty message</p>' }} />
        </div>
      )}
    </div>
  );
}
