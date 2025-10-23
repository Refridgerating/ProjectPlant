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
    <div className="min-h-screen bg-[#041510] text-emerald-50">
      <header className="border-b border-emerald-900/40 bg-[rgba(7,31,21,0.88)] shadow-[0_10px_30px_rgba(6,24,17,0.55)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-200 shadow-inner shadow-emerald-900/50">
                <Bars3Icon className="h-6 w-6" aria-hidden="true" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-emerald-50">{title}</h1>
                {subtitle ? <p className="text-sm text-emerald-200/70">{subtitle}</p> : null}
              </div>
            </div>
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <main className="w-full px-6 py-12">
        {children}
      </main>
    </div>
  );
}
