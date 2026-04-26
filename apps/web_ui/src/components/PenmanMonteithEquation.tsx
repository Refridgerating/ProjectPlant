import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { WateringRecommendation } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

type TermKey =
  | "eto"
  | "etc"
  | "kc"
  | "coef_0408"
  | "delta"
  | "rn"
  | "g"
  | "coef_900"
  | "temperature"
  | "gamma"
  | "u2"
  | "delta_e"
  | "coef_034";

type TermMeta = {
  label: string;
  description: string;
  units?: string;
};

type PenmanMonteithEquationProps = {
  recommendation?: WateringRecommendation | null;
};

type EquationBreakdown = {
  plantName: string;
  samples: number;
  coverageHours: number;
  lookbackHours: number;
  temperatureC: number;
  humidityPct: number;
  pressureKpa: number;
  netRadiation: number;
  soilHeatFlux: number;
  windSpeed: number;
  windSource: "telemetry" | "assumed";
  saturationVaporPressure: number;
  actualVaporPressure: number;
  vaporPressureDeficit: number;
  delta: number;
  gamma: number;
  radiationTerm: number;
  aerodynamicTerm: number;
  numerator: number;
  denominator: number;
  et0: number;
  referenceEt0: number;
  cropCoefficient: number;
};

const TERM_DETAILS: Record<TermKey, TermMeta> = {
  eto: {
    label: "ET0",
    description:
      "Reference evapotranspiration representing the water use of a well-watered short grass canopy. It is the target output of the equation.",
    units: "mm/day",
  },
  etc: {
    label: "ETc",
    description: "Crop-adjusted evapotranspiration that personalizes ET0 to the plant profile.",
    units: "mm/day",
  },
  kc: {
    label: "Kc",
    description: "Your plants personalized measurement. Crop coefficient that scales ET0 to ETc for this plant.",
  },
  coef_0408: {
    label: "0.408",
    description: "Conversion factor that turns net radiation in MJ/m^2/day into an equivalent depth of water in millimetres.",
  },
  delta: {
    label: "Delta",
    description: "Slope of the saturation vapour pressure curve evaluated at the air temperature.",
    units: "kPa per deg C",
  },
  rn: {
    label: "Rn",
    description: "Net radiation at the crop surface after accounting for incoming and outgoing longwave components.",
    units: "MJ/m^2/day",
  },
  g: {
    label: "G",
    description:
      "Soil heat flux density. For daily calculations this term is often small and may be approximated as zero.",
    units: "MJ/m^2/day",
  },
  coef_900: {
    label: "900",
    description: "Empirical constant that scales the aerodynamic component of the equation.",
  },
  temperature: {
    label: "T",
    description: "Mean air temperature measured at a height of two metres above the surface.",
    units: "deg C",
  },
  gamma: {
    label: "Gamma",
    description: "Psychrometric constant that links air temperature to vapour pressure behaviour.",
    units: "kPa per deg C",
  },
  u2: {
    label: "u2",
    description: "Wind speed measured at a height of two metres, influencing aerodynamic transport.",
    units: "m/s",
  },
  delta_e: {
    label: "Delta e",
    description: "Vapour pressure deficit, the difference between saturation and actual vapour pressure.",
    units: "kPa",
  },
  coef_034: {
    label: "0.34",
    description: "Empirical coefficient that adjusts aerodynamic resistance for wind speed influences.",
  },
};

type TermProps = {
  term?: TermKey;
  children: React.ReactNode;
  isActive: boolean;
  onActivate: (term: TermKey | null) => void;
};

function EquationTerm({ term, children, isActive, onActivate }: TermProps) {
  const interactive = Boolean(term);
  const baseClasses =
    "inline-flex items-end rounded px-1 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400/80";
  const highlightClasses = isActive
    ? "bg-emerald-500/25 text-emerald-50 shadow shadow-emerald-900/40"
    : interactive
    ? "hover:bg-[rgba(9,39,25,0.65)]"
    : "";

  if (!interactive) {
    return <span className="inline-flex items-end">{children}</span>;
  }

  return (
    <span
      tabIndex={0}
      onMouseEnter={() => onActivate(term)}
      onFocus={() => onActivate(term)}
      onMouseLeave={() => onActivate(null)}
      onBlur={() => onActivate(null)}
      className={`${baseClasses} ${highlightClasses}`}
    >
      {children}
    </span>
  );
}

type FractionProps = {
  numerator: React.ReactNode;
  denominator: React.ReactNode;
};

type BreakdownStatProps = {
  label: string;
  value: number;
  units?: string;
  decimals?: number;
  helper?: string;
};

function Fraction({ numerator, denominator }: FractionProps) {
  return (
    <span className="inline-flex flex-col items-center px-1">
      <span className="flex flex-wrap items-center justify-center gap-2">{numerator}</span>
      <span className="mt-1 h-[2px] w-full bg-emerald-600/60" />
      <span className="flex flex-wrap items-center justify-center gap-2">{denominator}</span>
    </span>
  );
}

function BreakdownStat({ label, value, units, decimals = 2, helper }: BreakdownStatProps) {
  const content = Number.isFinite(value) ? value.toFixed(decimals) : "-";
  return (
    <div
      className="rounded-xl border border-emerald-800/40 bg-[rgba(4,18,12,0.75)] p-3"
      title={helper}
    >
      <p className="text-[0.7rem] uppercase tracking-wide text-emerald-200/60">{label}</p>
      <p className="mt-1 text-lg font-semibold text-emerald-50">
        {content}
        {units ? <span className="ml-1 text-xs text-emerald-200/70">{units}</span> : null}
      </p>
      {helper ? <p className="mt-1 text-[0.65rem] text-emerald-200/60">{helper}</p> : null}
    </div>
  );
}

function InlineSubscript({ base, sub }: { base: ReactNode; sub: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-[0.08em]">
      <span>{base}</span>
      <sub className="text-[0.6em] leading-none text-emerald-200/70">{sub}</sub>
    </span>
  );
}

export function PenmanMonteithEquation({ recommendation }: PenmanMonteithEquationProps) {
  const [activeTerm, setActiveTerm] = useState<TermKey | null>(null);
  const breakdown = useMemo(() => computeBreakdown(recommendation), [recommendation]);
  const meta = activeTerm ? TERM_DETAILS[activeTerm] : null;

  const summaryTitle = meta?.label ?? "Hover a highlighted term";
  const summaryBody =
    meta?.description ?? "Move your cursor (or focus with the keyboard) over any variable to learn what it represents.";
  const summaryUnits = meta?.units;

  const numerator = useMemo(
    () => (
      <span className="flex flex-wrap items-center justify-center gap-2">
        <EquationTerm term="coef_0408" isActive={activeTerm === "coef_0408"} onActivate={setActiveTerm}>
          0.408
        </EquationTerm>
        <EquationTerm term="delta" isActive={activeTerm === "delta"} onActivate={setActiveTerm}>
          Δ
        </EquationTerm>
        <span>(</span>
        <EquationTerm term="rn" isActive={activeTerm === "rn"} onActivate={setActiveTerm}>
          <InlineSubscript base="R" sub="n" />
        </EquationTerm>
        <span>-</span>
        <EquationTerm term="g" isActive={activeTerm === "g"} onActivate={setActiveTerm}>
          G
        </EquationTerm>
        <span>)</span>
        <span>+</span>
        <EquationTerm term="gamma" isActive={activeTerm === "gamma"} onActivate={setActiveTerm}>
          γ
        </EquationTerm>
        <Fraction
          numerator={
            <>
              <EquationTerm term="coef_900" isActive={activeTerm === "coef_900"} onActivate={setActiveTerm}>
                900
              </EquationTerm>
            </>
          }
          denominator={
            <>
              <EquationTerm term="temperature" isActive={activeTerm === "temperature"} onActivate={setActiveTerm}>
                T
              </EquationTerm>
              <span>+</span>
              <span>273</span>
            </>
          }
        />
        <EquationTerm term="u2" isActive={activeTerm === "u2"} onActivate={setActiveTerm}>
          <InlineSubscript base="u" sub="2" />
        </EquationTerm>
        <EquationTerm term="delta_e" isActive={activeTerm === "delta_e"} onActivate={setActiveTerm}>
          Δe
        </EquationTerm>
      </span>
    ),
    [activeTerm]
  );

  const denominator = useMemo(
    () => (
      <span className="flex flex-wrap items-center justify-center gap-2">
        <EquationTerm term="delta" isActive={activeTerm === "delta"} onActivate={setActiveTerm}>
          Δ
        </EquationTerm>
        <span>+</span>
        <EquationTerm term="gamma" isActive={activeTerm === "gamma"} onActivate={setActiveTerm}>
          γ
        </EquationTerm>
        <span>(</span>
        <span>1</span>
        <span>+</span>
        <EquationTerm term="coef_034" isActive={activeTerm === "coef_034"} onActivate={setActiveTerm}>
          0.34
        </EquationTerm>
        <EquationTerm term="u2" isActive={activeTerm === "u2"} onActivate={setActiveTerm}>
          <InlineSubscript base="u" sub="2" />
        </EquationTerm>
        <span>)</span>
      </span>
    ),
    [activeTerm]
  );

  return (
    <CollapsibleTile
      id="plant-control-penman-monteith"
      title="Penman-Monteith Equation"
      subtitle="FAO-56 reference form combines energy balance and aerodynamic terms to compute ET0."
      className="p-5 text-emerald-100/85"
      bodyClassName="mt-5 space-y-5"
      titleClassName="text-lg font-semibold text-emerald-50"
      subtitleClassName="text-xs text-emerald-200/70"
    >
      <div className="max-w-full">
        <div className="inline-flex flex-wrap items-center gap-3 font-serif text-2xl text-emerald-50">
          <EquationTerm term="eto" isActive={activeTerm === "eto"} onActivate={setActiveTerm}>
            <InlineSubscript base="ET" sub="0" />
          </EquationTerm>
          <span className="text-emerald-200/70">=</span>
          <Fraction numerator={numerator} denominator={denominator} />
          <span>,</span>
          <EquationTerm term="etc" isActive={activeTerm === "etc"} onActivate={setActiveTerm}>
            <InlineSubscript base="ET" sub="c" />
          </EquationTerm>
          <span className="text-emerald-200/70">=</span>
          <EquationTerm term="kc" isActive={activeTerm === "kc"} onActivate={setActiveTerm}>
            <InlineSubscript base="K" sub="c" />
          </EquationTerm>
          <span className="text-emerald-200/70">*</span>
          <EquationTerm term="eto" isActive={activeTerm === "eto"} onActivate={setActiveTerm}>
            <InlineSubscript base="ET" sub="0" />
          </EquationTerm>
        </div>
      </div>
      <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-4 text-sm text-emerald-100/80 shadow-inner shadow-emerald-950/40">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">{summaryTitle}</span>
          {summaryUnits ? (
            <span className="text-xs uppercase tracking-wide text-emerald-200/70">{summaryUnits}</span>
          ) : null}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-emerald-200/70">{summaryBody}</p>
      </div>
      {breakdown ? (
        <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(4,18,12,0.78)] p-4 text-sm text-emerald-50 shadow-inner shadow-emerald-950/30">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-emerald-50">Latest ET0 inputs for {breakdown.plantName}</p>
              <p className="text-xs text-emerald-200/70">
                {breakdown.samples} samples - ~{formatNumber(breakdown.coverageHours, 1)} h window (configured lookback{" "}
                {formatNumber(breakdown.lookbackHours, 0)} h)
              </p>
            </div>
            <p className="text-xs text-emerald-200/70">
              Equation ~ {formatNumber(breakdown.et0, 2)} mm/day{" "}
              <span className="text-emerald-200/60">(hub output {formatNumber(breakdown.referenceEt0, 2)} mm/day)</span>
            </p>
          </div>
          <div className="mt-3 rounded-xl border border-emerald-800/50 bg-[rgba(5,28,18,0.75)] px-4 py-3 text-xs text-emerald-100/85 shadow-inner shadow-emerald-950/30">
            <p className="font-semibold text-emerald-50">
              Crop coefficient (Kc): <span className="text-emerald-200">{formatNumber(breakdown.cropCoefficient, 2)}</span>
            </p>
            <p className="mt-1 text-emerald-200/70">
              Applied to ET0 to personalize ETc for this plant profile.
            </p>
          </div>
          <div className="mt-4 space-y-4">
            <div>
              <h4 className="text-xs uppercase tracking-wide text-emerald-200/60">Climate inputs</h4>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <BreakdownStat label="Temperature (T)" value={breakdown.temperatureC} units="deg C" decimals={1} />
                <BreakdownStat label="Humidity (RH)" value={breakdown.humidityPct} units="%" decimals={0} />
                <BreakdownStat
                  label="Pressure"
                  value={breakdown.pressureKpa}
                  units="kPa"
                  decimals={1}
                  helper="Used to derive the psychrometric constant (gamma)."
                />
                <BreakdownStat
                  label="Net radiation (Rn)"
                  value={breakdown.netRadiation}
                  units="MJ/m^2-day"
                  decimals={2}
                  helper="Integrated solar energy observed during the lookback window."
                />
                <BreakdownStat
                  label="Wind (u2)"
                  value={breakdown.windSpeed}
                  units="m/s"
                  decimals={2}
                  helper={
                    breakdown.windSource === "telemetry"
                      ? "Measured 2 m wind speed."
                      : "No wind samples; using assumed value."
                  }
                />
                <BreakdownStat
                  label="VPD (e_s - e_a)"
                  value={breakdown.vaporPressureDeficit}
                  units="kPa"
                  decimals={2}
                  helper="Vapour pressure deficit derived from temperature and humidity."
                />
              </div>
            </div>
            <div>
              <h4 className="text-xs uppercase tracking-wide text-emerald-200/60">Derived terms</h4>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <BreakdownStat
                  label="Delta"
                  value={breakdown.delta}
                  units="kPa/deg C"
                  decimals={3}
                  helper="Slope of the saturation vapour pressure curve."
                />
                <BreakdownStat
                  label="Gamma"
                  value={breakdown.gamma}
                  units="kPa/deg C"
                  decimals={3}
                  helper="Psychrometric constant from air pressure."
                />
                <BreakdownStat
                  label="e_s"
                  value={breakdown.saturationVaporPressure}
                  units="kPa"
                  decimals={2}
                  helper="Saturation vapour pressure at the observed temperature."
                />
                <BreakdownStat
                  label="e_a"
                  value={breakdown.actualVaporPressure}
                  units="kPa"
                  decimals={2}
                  helper="Actual vapour pressure (humidity-adjusted)."
                />
              </div>
            </div>
            <div>
              <h4 className="text-xs uppercase tracking-wide text-emerald-200/60">Penman-Monteith terms</h4>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <BreakdownStat
                  label="Radiation numerator"
                  value={breakdown.radiationTerm}
                  units="mm/day"
                  decimals={2}
                  helper="0.408 * Delta * (Rn - G). Soil heat flux (G) assumed 0 for daily steps."
                />
                <BreakdownStat
                  label="Aerodynamic numerator"
                  value={breakdown.aerodynamicTerm}
                  units="mm/day"
                  decimals={2}
                  helper="Gamma * (900/(T + 273)) * u2 * (e_s - e_a)."
                />
                <BreakdownStat
                  label="Denominator"
                  value={breakdown.denominator}
                  decimals={2}
                  helper="Delta + Gamma * (1 + 0.34 * u2)."
                />
                <BreakdownStat
                  label="ET0 result"
                  value={breakdown.et0}
                  units="mm/day"
                  decimals={2}
                  helper="Computed ET0 prior to multiplying by the crop coefficient."
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </CollapsibleTile>
  );
}

function computeBreakdown(recommendation?: WateringRecommendation | null): EquationBreakdown | null {
  if (!recommendation) {
    return null;
  }
  const { climate, outputs, plant, assumptions } = recommendation;
  const {
    avg_temperature_c: temperatureC,
    avg_humidity_pct: humidityPct,
    avg_pressure_hpa: pressureHpa,
    net_radiation_mj_m2_day: netRadiation,
    wind_speed_m_s: observedWind,
    data_points: samples,
    coverage_hours: coverageHours,
  } = climate;
  if (
    !isFiniteNumber(temperatureC) ||
    !isFiniteNumber(humidityPct) ||
    !isFiniteNumber(pressureHpa) ||
    !isFiniteNumber(netRadiation)
  ) {
    return null;
  }

  const soilHeatFlux = 0;
  const pressureKpa = pressureHpa * 0.1;
  const temperatureKelvin = temperatureC + 273.0;
  const saturationVp = saturationVaporPressure(temperatureC);
  const actualVp = saturationVp * (clamp(humidityPct, 0, 100) / 100);
  const delta = deltaSlope(temperatureC, saturationVp);
  const gamma = 0.000665 * pressureKpa;
  const hasTelemetryWind = isFiniteNumber(observedWind) && observedWind > 0;
  const fallbackWind = assumptions?.assumed_wind_speed_m_s ?? 0.1;
  const rawWind = hasTelemetryWind ? observedWind : fallbackWind;
  const windSpeed = Math.max(rawWind ?? 0.05, 0.05);
  const vaporPressureDeficit = Math.max(saturationVp - actualVp, 0);

  const radiationTerm = 0.408 * delta * (netRadiation - soilHeatFlux);
  const aerodynamicTerm = gamma * (900 / temperatureKelvin) * windSpeed * vaporPressureDeficit;
  const numerator = radiationTerm + aerodynamicTerm;
  const denominator = delta + gamma * (1 + 0.34 * windSpeed);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const et0 = numerator / denominator;

  return {
    plantName: plant?.name ?? "Plant",
    cropCoefficient: plant?.crop_coefficient ?? 1,
    samples,
    coverageHours,
    lookbackHours: assumptions?.lookback_hours ?? 24,
    temperatureC,
    humidityPct,
    pressureKpa,
    netRadiation,
    soilHeatFlux,
    windSpeed,
    windSource: hasTelemetryWind ? "telemetry" : "assumed",
    saturationVaporPressure: saturationVp,
    actualVaporPressure: actualVp,
    vaporPressureDeficit,
    delta,
    gamma,
    radiationTerm,
    aerodynamicTerm,
    numerator,
    denominator,
    et0,
    referenceEt0: outputs?.et0_mm_day ?? et0,
  };
}

function saturationVaporPressure(tempC: number): number {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

function deltaSlope(tempC: number, saturationVp: number): number {
  return (4098 * saturationVp) / ((tempC + 237.3) ** 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(decimals);
}
