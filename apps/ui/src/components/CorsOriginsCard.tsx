type CorsOriginsCardProps = {
  origins: string[];
};

export function CorsOriginsCard({ origins }: CorsOriginsCardProps) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <h2 className="text-sm font-medium text-slate-400">Allowed Origins</h2>
      <ul className="mt-3 space-y-2 text-sm text-slate-300">
        {origins.length === 0 ? <li>None configured</li> : null}
        {origins.map((origin) => (
          <li key={origin} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900/90 px-3 py-2">
            <span className="truncate">{origin}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
