import React, { useState, useEffect } from 'react';
import { useAuth } from './context/AuthContext';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/DashboardPage';
import ImportExcelPage from './pages/ImportExcelPage';
import ComposePage from './pages/ComposePage';
import PreviewPage from './pages/PreviewPage';
import DraftsPage from './pages/DraftsPage';
import SchedulesPage from './pages/SchedulesPage';
import AccountsPage from './pages/AccountsPage';
import LogsPage from './pages/LogsPage';
import ConfigPage from './pages/ConfigPage';
import MasterPanelPage from './pages/MasterPanelPage';

import { 
  Send, LayoutDashboard, Bookmark, Calendar, Mail, 
  ListFilter, LogOut, ShieldCheck, Crown, Menu, X, FileSpreadsheet, Eye, Sliders
} from 'lucide-react';

export default function App() {
  const { user, loading, logout, isMaster } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [composerInitialData, setComposerInitialData] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appName, setAppName] = useState('Parth mailing');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        if (data?.app) setAppName(data.app);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isMaster && (activeTab === 'master' || activeTab === 'accounts')) {
      setActiveTab('dashboard');
    }
  }, [isMaster, activeTab]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium">Initializing Parth Mailing...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  const handleEditDraft = (draft) => {
    setComposerInitialData(draft);
    setActiveTab('compose');
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'import', label: 'Import Excel', icon: FileSpreadsheet },
    { id: 'compose', label: 'Composer', icon: Send },
    { id: 'preview', label: 'Preview', icon: Eye },
    { id: 'schedules', label: 'Campaign Queue', icon: Calendar },
    { id: 'config', label: 'Configuration', icon: Sliders },
    { id: 'drafts', label: 'Saved Drafts', icon: Bookmark },
    { id: 'logs', label: 'Delivery Logs', icon: ListFilter }
  ];

  if (isMaster) {
    navItems.push({ id: 'accounts', label: 'Sending Accounts', icon: Mail });
    navItems.push({ id: 'master', label: 'Master Panel', icon: Crown, highlight: true });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="bg-slate-900/90 border-b border-slate-800 sticky top-0 z-40 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Logo & Compliance status */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <span className="font-extrabold text-white text-base tracking-tight">{appName}</span>
                <span className="text-[10px] block text-indigo-400 font-mono -mt-1">v1.0 Pro</span>
              </div>
            </div>

            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Google Policy: 100% Guard Active</span>
            </div>
          </div>

          {/* User profile & actions */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs font-bold text-white">{user.name}</span>
              <span className="text-[11px] text-slate-400 font-mono flex items-center justify-end gap-1">
                {isMaster ? (
                  <span className="text-purple-400 font-semibold flex items-center gap-0.5">
                    <Crown className="w-3 h-3" /> Master Admin
                  </span>
                ) : (
                  <span>Verified User</span>
                )}
              </span>
            </div>

            <button
              onClick={logout}
              className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-xl transition-colors border border-transparent hover:border-slate-700"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>

            {/* Mobile menu trigger */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Desktop Navigation Bar */}
        <div className="hidden md:block bg-slate-950/60 border-t border-slate-800/80">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <nav className="flex space-x-1 py-1.5 overflow-x-auto">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (item.id === 'compose' && activeTab !== 'compose') {
                        setComposerInitialData(null);
                      }
                      setActiveTab(item.id);
                    }}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-xl flex items-center gap-2 whitespace-nowrap transition-all ${
                      active
                        ? item.highlight
                          ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30 font-bold'
                          : 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                        : item.highlight
                        ? 'text-purple-300 hover:text-white hover:bg-purple-950/50 border border-purple-500/20'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Mobile Navigation Dropdown */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-slate-900 border-b border-slate-800 px-4 py-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold rounded-xl flex items-center gap-2 ${
                    active ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {activeTab === 'dashboard' && (
          <DashboardPage 
            setActiveTab={setActiveTab} 
            setComposerInitialData={setComposerInitialData} 
          />
        )}

        {activeTab === 'import' && (
          <ImportExcelPage setActiveTab={setActiveTab} />
        )}

        {activeTab === 'compose' && (
          <ComposePage 
            initialData={composerInitialData} 
            onDraftSaved={() => setActiveTab('drafts')}
            onScheduled={() => setActiveTab('schedules')}
          />
        )}

        {activeTab === 'preview' && (
          <PreviewPage />
        )}

        {activeTab === 'config' && (
          <ConfigPage />
        )}

        {activeTab === 'drafts' && (
          <DraftsPage onEditDraft={handleEditDraft} />
        )}

        {activeTab === 'schedules' && (
          <SchedulesPage />
        )}

        {activeTab === 'accounts' && isMaster && (
          <AccountsPage />
        )}

        {activeTab === 'logs' && (
          <LogsPage />
        )}

        {activeTab === 'master' && isMaster && (
          <MasterPanelPage />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 py-4 text-center text-xs text-slate-500">
        <p>Parth mailing • Google Policy Compliant SMTP Engine • Strict 500 Daily Quota Protection Active</p>
      </footer>
    </div>
  );
}
