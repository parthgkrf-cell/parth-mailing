import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { 
  Send, Calendar, Bookmark, ShieldAlert, CheckCircle, 
  Sparkles, Clock, AlertCircle, Info, RefreshCw
} from 'lucide-react';

export default function ComposePage({ initialData, onDraftSaved, onScheduled }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [subject, setSubject] = useState('');
  const [recipients, setRecipients] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [activeTab, setActiveTab] = useState('html'); // 'html' or 'preview'
  
  // Schedule settings
  const [scheduledFor, setScheduledFor] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(15);
  const [randomJitter, setRandomJitter] = useState(8);

  // Compliance analysis state
  const [compliance, setCompliance] = useState(null);
  const [checkingCompliance, setCheckingCompliance] = useState(false);

  // Feedback states
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    loadAccounts();
    // Default scheduled time 5 minutes from now in local datetime-local format
    const now = new Date(Date.now() + 5 * 60 * 1000);
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setScheduledFor(localIso);
  }, []);

  useEffect(() => {
    if (initialData) {
      if (initialData.subject) setSubject(initialData.subject);
      if (initialData.recipients) setRecipients(initialData.recipients);
      if (initialData.body_html) setBodyHtml(initialData.body_html);
      if (initialData.body_text) setBodyText(initialData.body_text);
      if (initialData.smtp_account_id) setSelectedAccountId(String(initialData.smtp_account_id));
    }
  }, [initialData]);

  const loadAccounts = async () => {
    try {
      const res = await api.getAccounts();
      setAccounts(res.accounts || []);
      if (res.accounts && res.accounts.length > 0 && !selectedAccountId) {
        setSelectedAccountId(String(res.accounts[0].id));
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  };

  // Run compliance check whenever subject, recipients, or body changes
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!subject.trim() && !recipients.trim()) {
        setCompliance(null);
        return;
      }
      try {
        setCheckingCompliance(true);
        const res = await api.checkCompliance({
          subject,
          body_html: bodyHtml,
          body_text: bodyText,
          recipients
        });
        setCompliance(res);
      } catch (err) {
        // quiet error
      } finally {
        setCheckingCompliance(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [subject, recipients, bodyHtml, bodyText]);

  // Save Draft
  const handleSaveDraft = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    setLoading(true);
    try {
      await api.saveDraft({
        title: subject ? `Draft: ${subject.slice(0, 30)}` : 'Untitled Draft',
        subject,
        recipients,
        body_html: bodyHtml,
        body_text: bodyText,
        smtp_account_id: selectedAccountId ? Number(selectedAccountId) : null
      });
      setSuccessMsg('Draft saved successfully!');
      if (onDraftSaved) onDraftSaved();
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save draft.');
    } finally {
      setLoading(false);
    }
  };

  // Instant Send (for tests <= 10)
  const handleSendNow = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    setLoading(true);
    try {
      const res = await api.sendNow({
        subject,
        recipients,
        body_html: bodyHtml,
        body_text: bodyText,
        smtp_account_id: selectedAccountId ? Number(selectedAccountId) : null
      });
      setSuccessMsg(res.message);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to send.');
    } finally {
      setLoading(false);
    }
  };

  // Schedule Campaign
  const handleSchedule = async () => {
    setErrorMsg('');
    setSuccessMsg('');

    if (!scheduledFor) {
      setErrorMsg('Please specify a scheduled launch date and time.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.createSchedule({
        subject,
        recipients,
        body_html: bodyHtml,
        body_text: bodyText,
        scheduled_for: new Date(scheduledFor).toISOString(),
        smtp_account_id: selectedAccountId ? Number(selectedAccountId) : null,
        interval_seconds: Number(intervalSeconds),
        random_jitter: Number(randomJitter)
      });
      setSuccessMsg(res.message);
      if (onScheduled) onScheduled();
    } catch (err) {
      setErrorMsg(err.message || 'Failed to schedule campaign.');
    } finally {
      setLoading(false);
    }
  };

  const recipientCount = compliance?.recipientCount || 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Send className="w-6 h-6 text-indigo-400" />
            Compose & Schedule Email
          </h2>
          <p className="text-slate-400 text-sm">
            Craft your email message, check real-time Google anti-spam compliance, and schedule with pacing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={loading}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-xl border border-slate-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Bookmark className="w-4 h-4 text-purple-400" />
            Save Draft
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="p-4 bg-emerald-950/60 border border-emerald-800 rounded-xl text-emerald-300 text-sm flex items-center gap-3">
          <CheckCircle className="w-5 h-5 shrink-0 text-emerald-400" />
          <span>{successMsg}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 bg-red-950/60 border border-red-800 rounded-xl text-red-300 text-sm flex items-center gap-3">
          <AlertCircle className="w-5 h-5 shrink-0 text-red-400" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Editor Section (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            {/* Sender Account */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Sending Gmail Account
              </label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">Auto-Rotate across all active accounts (Recommended for heavy campaigns)</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label} ({acc.email}) — {acc.sent_today}/{acc.daily_limit} sent today
                  </option>
                ))}
              </select>
              {accounts.length === 0 && (
                <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  No Gmail accounts connected yet. Please connect an account in the Accounts tab.
                </p>
              )}
            </div>

            {/* Subject */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Subject Line
                </label>
                {subject && subject === subject.toUpperCase() && subject.length > 5 && (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5" /> Avoid All Caps
                  </span>
                )}
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Important Announcement Regarding..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            {/* Recipients */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Recipients (Separate by commas or new lines)
                </label>
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-medium">
                  {recipientCount} detected
                </span>
              </div>
              <textarea
                rows={3}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="client1@example.com, client2@example.com&#10;client3@example.com"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors font-mono"
              />
            </div>

            {/* Body Editor with Tabs */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setActiveTab('html')}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                      activeTab === 'html' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    HTML Source
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('preview')}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                      activeTab === 'preview' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Live Preview
                  </button>
                </div>
                <span className="text-[11px] text-slate-400">Supports standard HTML email markup</span>
              </div>

              {activeTab === 'html' ? (
                <textarea
                  rows={9}
                  value={bodyHtml}
                  onChange={(e) => setBodyHtml(e.target.value)}
                  placeholder="<h2>Hello there!</h2><p>Here is your scheduled update...</p>"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-4 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors font-mono"
                />
              ) : (
                <div 
                  className="w-full h-56 bg-white text-slate-900 rounded-xl p-4 overflow-y-auto prose prose-sm max-w-none shadow-inner"
                  dangerouslySetInnerHTML={{ __html: bodyHtml || '<p style="color:#888;">No content written yet.</p>' }}
                />
              )}
            </div>

            {/* Plain-text alternative fallback */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                Plain-Text Alternative (Optional - Recommended by Google for anti-spam scoring)
              </label>
              <textarea
                rows={2}
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Plain text content (will automatically be stripped from HTML if left blank)..."
                className="w-full bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Sidebar: Compliance & Dispatch Controls (1 col) */}
        <div className="space-y-6">
          {/* Google Policy & Spam Pre-flight Box */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-emerald-400" />
                Google Compliance Check
              </h3>
              {checkingCompliance && (
                <RefreshCw className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
              )}
            </div>

            {compliance ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800">
                  <div>
                    <div className="text-xs text-slate-400">Deliverability Grade</div>
                    <div className="text-2xl font-black text-emerald-400">
                      {compliance.deliveryGrade}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-400">Spam Risk Score</div>
                    <div className={`text-lg font-bold ${
                      compliance.spamRiskScore < 20 ? 'text-emerald-400' :
                      compliance.spamRiskScore < 50 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {compliance.spamRiskScore}%
                    </div>
                  </div>
                </div>

                {compliance.warnings.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">
                      Warnings to Consider:
                    </div>
                    {compliance.warnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-300/90 bg-amber-950/30 border border-amber-900/50 p-2 rounded-lg flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                {compliance.issues.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-red-400 uppercase tracking-wider">
                      Blocking Issues:
                    </div>
                    {compliance.issues.map((issue, i) => (
                      <div key={i} className="text-xs text-red-300/90 bg-red-950/30 border border-red-900/50 p-2 rounded-lg flex items-start gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-400" />
                        <span>{issue}</span>
                      </div>
                    ))}
                  </div>
                )}

                {compliance.warnings.length === 0 && compliance.issues.length === 0 && (
                  <div className="p-3 bg-emerald-950/30 border border-emerald-900/50 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>Clean email! Complies with Google's 2024+ bulk sender regulations.</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500 leading-relaxed">
                Type in your subject and recipients to see real-time deliverability scores and Google spam filter warnings.
              </p>
            )}
          </div>

          {/* Schedule & Pacing Configuration */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
            <h3 className="font-bold text-white text-sm flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-400" />
              Schedule & Safe Pacing
            </h3>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Launch Date & Time
              </label>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs text-slate-300 mb-1">
                <span className="font-semibold uppercase tracking-wider">Delay Between Sends</span>
                <span className="text-sky-400 font-bold">{intervalSeconds} seconds</span>
              </div>
              <input
                type="range"
                min="10"
                max="60"
                step="5"
                value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(e.target.value)}
                className="w-full accent-indigo-500"
              />
              <p className="text-[11px] text-slate-500 mt-0.5">
                Google flags bursts. A 15+ second delay keeps sending within Google's safe threshold.
              </p>
            </div>

            <div>
              <div className="flex justify-between text-xs text-slate-300 mb-1">
                <span className="font-semibold uppercase tracking-wider">Human Jitter Delay</span>
                <span className="text-purple-400 font-bold">+{randomJitter}s random</span>
              </div>
              <input
                type="range"
                min="2"
                max="20"
                value={randomJitter}
                onChange={(e) => setRandomJitter(e.target.value)}
                className="w-full accent-purple-500"
              />
              <p className="text-[11px] text-slate-500 mt-0.5">
                Simulates organic human intervals so outgoing mail doesn't look machine-automated to Google.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="pt-2 space-y-2">
              <button
                type="button"
                onClick={handleSchedule}
                disabled={loading || accounts.length === 0}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-all shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2"
              >
                <Calendar className="w-4 h-4" />
                Schedule Campaign Queue
              </button>

              {recipientCount <= 10 && (
                <button
                  type="button"
                  onClick={handleSendNow}
                  disabled={loading || accounts.length === 0}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold rounded-xl border border-slate-700 flex items-center justify-center gap-2 transition-colors"
                >
                  <Send className="w-3.5 h-3.5 text-emerald-400" />
                  Instant Test Send (Immediate)
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

