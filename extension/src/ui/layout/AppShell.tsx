import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { BookUser, FileText, History, LayoutDashboard, ListChecks, Menu, MessageSquarePlus, Moon, Settings as SettingsIcon, Sun, Upload, X } from 'lucide-react';
import { cx } from '../components';
import { useSettings } from '../settingsContext';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/import', label: 'Import Contacts', icon: Upload },
  { to: '/contacts', label: 'Contacts', icon: BookUser },
  { to: '/lists', label: 'Contact Lists', icon: ListChecks },
  { to: '/templates', label: 'Message Templates', icon: FileText },
  { to: '/campaigns/new', label: 'New Campaign', icon: MessageSquarePlus },
  { to: '/campaigns', label: 'Campaign History', icon: History, end: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { settings, update } = useSettings();
  const isDark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 py-5">
        <img src="icons/icon48.png" alt="" className="size-8" />
        <div>
          <p className="text-sm font-semibold leading-tight">WA Campaigns</p>
          <p className="text-xs text-slate-500">Local-first messaging</p>
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 px-2">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
        <button
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          onClick={() => void update({ ...settings, theme: isDark ? 'light' : 'dark' })}
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />} {isDark ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </nav>
  );
  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl dark:bg-slate-900">
            <button className="absolute top-4 right-3 p-1" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden dark:border-slate-800 dark:bg-slate-900">
          <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <span className="font-semibold">WA Campaigns</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
