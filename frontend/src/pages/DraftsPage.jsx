import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { FileText, Send, Trash2, Edit3, Clock, AlertCircle } from 'lucide-react';

export default function DraftsPage({ onEditDraft }) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    loadDrafts();
  }, []);

  const loadDrafts = async () => {
    try {
      setLoading(true);
      const res = await api.getDrafts();
      setDrafts(res.drafts || []);
    } catch (err) {
      console.error('Failed to load drafts:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this draft?')) return;
    try {
      await api.deleteDraft(id);
      setActionMsg('Draft deleted.');
      loadDrafts();
    } catch (err) {
      alert(err.message || 'Failed to delete draft');
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <FileText className="w-6 h-6 text-purple-400" />
            Saved Drafts
          </h2>
          <p className="text-slate-400 text-sm">
            Resume editing your unfinished emails or convert them to scheduled campaigns.
          </p>
        </div>
      </div>

      {actionMsg && (
        <div className="p-3 bg-indigo-950/50 border border-indigo-800 rounded-xl text-indigo-300 text-sm">
          {actionMsg}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-slate-500">Loading drafts...</div>
      ) : drafts.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/60 border border-slate-800 rounded-2xl">
          <FileText className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-white">No drafts yet</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1">
            Whenever you compose an email, you can save it as a draft to resume later.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between hover:border-slate-700 transition-colors"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-bold text-white text-base truncate">
                    {draft.title || draft.subject || 'Untitled Draft'}
                  </h3>
                  <span className="text-[11px] text-slate-500 shrink-0 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(draft.updated_at).toLocaleDateString()}
                  </span>
                </div>

                <p className="text-xs text-indigo-400 font-medium mb-2">
                  Subject: {draft.subject || '<No Subject>'}
                </p>

                <div className="text-xs text-slate-400 line-clamp-3 mb-4 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80 font-mono">
                  {draft.body_text || (draft.body_html ? draft.body_html.replace(/<[^>]*>?/gm, '') : 'No body content...')}
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 text-xs">
                <span className="text-slate-500">
                  {draft.recipients ? `${draft.recipients.split(',').length} recipient(s)` : 'No recipients yet'}
                </span>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onEditDraft(draft)}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg flex items-center gap-1.5 transition-colors"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit & Schedule
                  </button>
                  <button
                    onClick={() => handleDelete(draft.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 transition-colors rounded-lg hover:bg-slate-800"
                    title="Delete Draft"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

