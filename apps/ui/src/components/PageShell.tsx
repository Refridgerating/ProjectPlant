import { ReactNode } from "react";
import { Bars3Icon } from "@heroicons/react/24/outline";

type PageShellProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageShell({ title, subtitle, actions, children }: PageShellProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/20 text-brand-300">
                <Bars3Icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                {subtitle ? <p className="text-sm text-slate-400">{subtitle}</p> : null}
              </div>
            </div>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">
        {children}
      </main>
    </div>
  );
}
