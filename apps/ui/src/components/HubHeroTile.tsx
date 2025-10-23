import { HubInfo } from "../api/hubClient";

type HubHeroTileProps = {
  info: HubInfo;
};

export function HubHeroTile({ info }: HubHeroTileProps) {
  const mqttLabel = info.mqtt_enabled ? "Connected" : "Disabled";
  const mqttDescription = info.mqtt_enabled
    ? `Broker ${info.mqtt_host}:${info.mqtt_port}`
    : "Enable MQTT in the hub settings.";
  const debugLabel = info.debug ? "Enabled" : "Disabled";
  const debugDescription = info.debug ? "Verbose logging and hot reload enabled." : "Running in production mode.";

  return (
    <section className="relative isolate w-full overflow-hidden rounded-none border border-emerald-500/35 bg-[rgba(4,18,12,0.95)] px-6 py-16 text-center shadow-[0_35px_120px_rgba(4,18,12,0.75)] transition-all duration-500 sm:px-10 md:px-16 lg:rounded-[3rem] lg:px-20 xl:px-28">
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0c2a1a] via-[#030a06] to-[#173521] opacity-95" />
        <div
          className="absolute inset-0 opacity-80"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 15%, rgba(159, 235, 188, 0.18), transparent 55%), radial-gradient(circle at 80% 20%, rgba(116, 191, 150, 0.18), transparent 60%), radial-gradient(circle at 50% 82%, rgba(58, 123, 84, 0.2), transparent 65%)",
          }}
        />
        <div className="pointer-events-none absolute -left-16 top-12 h-72 w-72 rounded-full bg-emerald-500/25 blur-3xl" />
        <div className="pointer-events-none absolute right-[-12%] bottom-6 h-80 w-80 rounded-full bg-lime-400/20 blur-3xl" />
        <div
          className="absolute inset-0 opacity-70 mix-blend-screen"
          style={{
            backgroundImage:
              "linear-gradient(135deg, rgba(42, 87, 58, 0.35) 10%, rgba(42, 87, 58, 0) 40%), linear-gradient(225deg, rgba(126, 255, 205, 0.15) 5%, rgba(126, 255, 205, 0) 35%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(115deg, rgba(99, 187, 133, 0.12) 25%, rgba(99, 187, 133, 0) 60%), linear-gradient(285deg, rgba(64, 117, 86, 0.2) 20%, rgba(64, 117, 86, 0) 55%)",
            backgroundSize: "220% 220%",
          }}
        />
      </div>

      <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-8">
        <span className="text-xs font-semibold uppercase tracking-[0.55em] text-emerald-200/70">
          Project Plant
        </span>
        <span
          className="select-none text-6xl font-black uppercase tracking-[0.3em] text-emerald-100 drop-shadow-[0_20px_40px_rgba(14,60,35,0.55)] sm:text-7xl md:text-8xl"
          style={{
            textShadow:
              "0 1px 0 #0c2f1c, 0 2px 0 #0a2817, 0 3px 0 #082213, 0 4px 0 #071d10, 0 6px 15px rgba(8, 36, 20, 0.75)",
          }}
        >
          HUB
        </span>
        <p className="max-w-xl text-sm text-emerald-100/80 sm:text-base">
          Welcome to the heart of your smart garden. Explore live diagnostics, weather intelligence, responsive
          controls, and bespoke plant care from a lush botanical command center.
        </p>

        <div className="grid w-full gap-6 rounded-3xl border border-emerald-400/30 bg-[rgba(12,42,26,0.45)] p-6 text-left shadow-inner shadow-emerald-900/40 sm:grid-cols-3">
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-900/50 p-5 backdrop-blur-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/70">Release</h2>
            <p className="mt-3 text-3xl font-bold text-emerald-100">{info.version}</p>
            <p className="mt-1 text-sm text-emerald-200/80">{info.name}</p>
          </div>
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-900/50 p-5 backdrop-blur-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/70">Debug Mode</h2>
            <p className="mt-3 text-3xl font-bold text-emerald-100">{debugLabel}</p>
            <p className="mt-1 text-sm text-emerald-200/80">{debugDescription}</p>
          </div>
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-900/50 p-5 backdrop-blur-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/70">MQTT Connectivity</h2>
            <span
              className={`mt-3 inline-flex items-center gap-2 rounded-full border px-4 py-1 text-xs font-semibold ${
                info.mqtt_enabled
                  ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
                  : "border-rose-400/60 bg-rose-500/20 text-rose-100"
              }`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-current" />
              {mqttLabel}
            </span>
            <p className="mt-2 text-sm text-emerald-200/80">{mqttDescription}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
