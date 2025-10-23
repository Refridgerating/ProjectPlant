import { CollapsibleTile } from "./CollapsibleTile";

type CorsOriginsCardProps = {
  origins: string[];
};

export function CorsOriginsCard({ origins }: CorsOriginsCardProps) {
  const hasOrigins = origins.length > 0;

  return (
    <CollapsibleTile
      id="plant-conditions-cors-origins"
      title="Allowed Origins"
      subtitle={hasOrigins ? "Origins allowed to issue browser requests to the hub." : "No CORS origins configured yet."}
      className="p-6 text-sm text-emerald-100/85"
      bodyClassName="mt-3 space-y-2"
    >
      {hasOrigins ? (
        <ul className="space-y-2">
          {origins.map((origin) => (
            <li
              key={origin}
              className="flex items-center justify-between gap-3 rounded-xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] px-3 py-2 shadow-inner shadow-emerald-950/40"
            >
              <span className="truncate">{origin}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-emerald-200/60">Add entries in the hub configuration to permit browser access.</p>
      )}
    </CollapsibleTile>
  );
}
