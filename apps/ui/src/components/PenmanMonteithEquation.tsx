import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CollapsibleTile } from "./CollapsibleTile";

type TermKey =
  | "eto"
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

const TERM_DETAILS: Record<TermKey, TermMeta> = {
  eto: {
    label: "ET₀",
    description:
      "Reference evapotranspiration representing the water use of a well-watered short grass canopy. It is the target output of the equation.",
    units: "mm/day",
  },
  coef_0408: {
    label: "0.408",
    description:
      "Conversion factor that turns net radiation in MJ/m²/day into an equivalent depth of water in millimetres.",
  },
  delta: {
    label: "Δ",
    description: "Slope of the saturation vapour pressure curve evaluated at the air temperature.",
    units: "kPa per deg C",
  },
  rn: {
    label: "Rn",
    description: "Net radiation at the crop surface after accounting for incoming and outgoing longwave components.",
    units: "MJ/m²/day",
  },
  g: {
    label: "G",
    description:
      "Soil heat flux density. For daily calculations this term is often small and may be approximated as zero.",
    units: "MJ/m²/day",
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
    label: "γ",
    description: "Psychrometric constant that links air temperature to vapour pressure behaviour.",
    units: "kPa per deg C",
  },
  u2: {
    label: "u₂",
    description: "Wind speed measured at a height of two metres, influencing aerodynamic transport.",
    units: "m/s",
  },
  delta_e: {
    label: "Δe",
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

function Fraction({ numerator, denominator }: FractionProps) {
  return (
    <span className="inline-flex flex-col items-center px-1">
      <span className="flex flex-wrap items-center justify-center gap-2">{numerator}</span>
      <span className="mt-1 h-[2px] w-full bg-emerald-600/60" />
      <span className="flex flex-wrap items-center justify-center gap-2">{denominator}</span>
    </span>
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

export function PenmanMonteithEquation() {
  const [activeTerm, setActiveTerm] = useState<TermKey | null>(null);
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
        <div className="inline-flex flex-wrap items-center gap-4 font-serif text-3xl text-emerald-50">
          <EquationTerm term="eto" isActive={activeTerm === "eto"} onActivate={setActiveTerm}>
            <InlineSubscript base="ET" sub="0" />
          </EquationTerm>
          <span className="text-emerald-200/70">=</span>
          <Fraction numerator={numerator} denominator={denominator} />
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
    </CollapsibleTile>
  );
}
