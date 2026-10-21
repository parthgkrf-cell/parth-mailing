import React, { useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { parseExcelFile } from '../utils/excelParse';
import { FileSpreadsheet, Upload, Trash2, CheckCircle } from 'lucide-react';

export default function ImportExcelPage({ setActiveTab }) {
  const { recipients, setRecipients, clearRecipients } = useCampaign();
  const [invalid, setInvalid] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('append');

  const handleFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const batches = await Promise.all(files.map((file) => parseExcelFile(file)));
      const rows = batches.flatMap((batch) => batch.rows);
      const skipped = batches.reduce((sum, batch) => sum + batch.invalid, 0);
      setInvalid(skipped);
      setRecipients((current) => (mode === 'replace' ? rows : [...current, ...rows]));
    } catch (err) {
      setError(err.message || 'Could not read that Excel file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-indigo-400" />
              Import Excel
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Template, Sender Account, and Sender Name columns are read from the sheet so Composer and Preview can use them.
            </p>
          </div>
        </div>

        <label className="block border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-2xl p-10 text-center cursor-pointer bg-slate-950/40">
          <Upload className="w-10 h-10 text-indigo-400 mx-auto mb-3" />
          <div className="text-white font-semibold">{busy ? 'Reading files…' : 'Drop Excel / CSV here or browse'}</div>
          <p className="text-xs text-slate-500 mt-2">Columns: Name, Email, Template, Sender Email, Sender Name</p>
          <input
            type="file"
            multiple
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>

        <div className="flex flex-wrap gap-4 mt-4 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" checked={mode === 'append'} onChange={() => setMode('append')} />
            Append to list
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            Replace list
          </label>
        </div>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400">Valid recipients</div>
          <div className="text-2xl font-bold text-emerald-400">{recipients.length}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400">Invalid rows</div>
          <div className="text-2xl font-bold text-red-400">{invalid}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400">Templates found</div>
          <div className="text-2xl font-bold text-indigo-400">{new Set(recipients.map((row) => row.template).filter(Boolean)).size}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400">Sender names</div>
          <div className="text-2xl font-bold text-sky-400">{new Set(recipients.map((row) => row.sender_name).filter(Boolean)).size}</div>
        </div>
      </div>

      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="font-bold text-white">Imported contacts</h3>
          <div className="flex gap-2">
            <button onClick={() => setActiveTab('compose')} className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg">
              Open Composer
            </button>
            <button onClick={clearRecipients} className="px-3 py-1.5 bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase">
              <tr>
                <th className="py-2 px-3">Name</th>
                <th className="py-2 px-3">Email</th>
                <th className="py-2 px-3">Template</th>
                <th className="py-2 px-3">Sender</th>
                <th className="py-2 px-3">Sender Name</th>
                <th className="py-2 px-3">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {recipients.length === 0 && (
                <tr><td colSpan="6" className="py-8 text-center text-slate-500">No contacts yet.</td></tr>
              )}
              {recipients.slice(0, 200).map((row) => (
                <tr key={row.id} className="text-slate-200">
                  <td className="py-2 px-3">{row.name || '—'}</td>
                  <td className="py-2 px-3 font-mono">{row.email}</td>
                  <td className="py-2 px-3 text-indigo-300">{row.template || '—'}</td>
                  <td className="py-2 px-3">{row.sender || '—'}</td>
                  <td className="py-2 px-3">{row.sender_name || '—'}</td>
                  <td className="py-2 px-3 text-slate-500">{row.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recipients.length > 0 && (
          <div className="p-3 text-xs text-emerald-400 flex items-center gap-1 border-t border-slate-800">
            <CheckCircle className="w-3.5 h-3.5" />
            Template and sender name stay with each row for Preview and sending.
          </div>
        )}
      </div>
    </div>
  );
}
