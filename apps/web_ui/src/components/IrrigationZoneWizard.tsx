import { useEffect, useMemo, useState } from "react";
import {
  CreateIrrigationZonePayload,
  IrrigationZone,
} from "../api/hubClient";

type StepId = "irrigation" | "sun" | "slope" | "planting" | "name" | "review";

type WizardOption<T> = {
  id: string;
  value: T;
  label: string;
  description: string;
};

const IRRIGATION_OPTIONS: WizardOption<CreateIrrigationZonePayload["irrigation_type"]>[] = [
  {
    id: "drip",
    value: "drip",
    label: "Drip / micro emitters",
    description: "Emitters, soaker hoses, or low-flow tubing delivering water right at the root zone.",
  },
  {
    id: "spray",
    value: "spray",
    label: "Spray / sprinklers",
    description: "Spray heads, rotors, or impact sprinklers covering a broader area.",
  },
];

const SUN_OPTIONS: WizardOption<CreateIrrigationZonePayload["sun_exposure"]>[] = [
  {
    id: "full",
    value: "full_sun",
    label: "Full sun",
    description: "6+ hours of direct sun during peak season.",
  },
  {
    id: "part",
    value: "part_sun",
    label: "Part sun",
    description: "Filtered sun or a mix of sun and shade (3-6 hours).",
  },
  {
    id: "shade",
    value: "shade",
    label: "Shade",
    description: "Dense canopy or structures limit direct sun (<3 hours).",
  },
];

const SLOPE_OPTIONS: WizardOption<boolean>[] = [
  {
    id: "flat",
    value: false,
    label: "Flat / no slope",
    description: "Level grade without run-off concerns.",
  },
  {
    id: "slope",
    value: true,
    label: "Has slope",
    description: "Noticeable slope or berm where water could run downhill.",
  },
];

const PLANTING_OPTIONS: WizardOption<CreateIrrigationZonePayload["planting_type"]>[] = [
  {
    id: "lawn",
    value: "lawn",
    label: "Lawn / turfgrass",
    description: "Grass areas that need even coverage.",
  },
  {
    id: "beds",
    value: "flower_bed",
    label: "Flower or veggie beds",
    description: "Annual/perennial beds, veggie plots, or mixed plantings.",
  },
  {
    id: "ground",
    value: "ground_cover",
    label: "Ground covers",
    description: "Low-growing spreads like ivy, moss, or creeping thyme.",
  },
  {
    id: "trees",
    value: "trees",
    label: "Trees / shrubs",
    description: "Deep-rooted woody plants or orchards.",
  },
];

const STEP_SEQUENCE: StepConfig[] = [
  {
    id: "irrigation",
    title: "Delivery",
    prompt: "How does this zone deliver water?",
    options: IRRIGATION_OPTIONS,
  },
  {
    id: "sun",
    title: "Sun",
    prompt: "What sun exposure does the area receive?",
    options: SUN_OPTIONS,
  },
  {
    id: "slope",
    title: "Slope",
    prompt: "Does this zone sit on a slope?",
    options: SLOPE_OPTIONS,
  },
  {
    id: "planting",
    title: "Planting",
    prompt: "What type of planting is it serving?",
    options: PLANTING_OPTIONS,
  },
  {
    id: "name",
    title: "Name",
    prompt: "Give the zone an easy name to recognize.",
  },
  {
    id: "review",
    title: "Review",
    prompt: "Confirm the details and create the zone.",
  },
];

type StepConfig = {
  id: StepId;
  title: string;
  prompt: string;
  options?: WizardOption<any>[];
};

type WizardState = {
  irrigationType: CreateIrrigationZonePayload["irrigation_type"] | null;
  sunExposure: CreateIrrigationZonePayload["sun_exposure"] | null;
  slope: boolean | null;
  plantingType: CreateIrrigationZonePayload["planting_type"] | null;
  name: string;
  coverage: string;
  description: string;
};

const INITIAL_STATE: WizardState = {
  irrigationType: null,
  sunExposure: null,
  slope: null,
  plantingType: null,
  name: "",
  coverage: "",
  description: "",
};

function formatSunLabel(value: CreateIrrigationZonePayload["sun_exposure"]): string {
  switch (value) {
    case "full_sun":
      return "Full sun";
    case "part_sun":
      return "Part sun";
    case "shade":
      return "Shade";
    default:
      return value;
  }
}

function formatPlantingLabel(value: CreateIrrigationZonePayload["planting_type"]): string {
  switch (value) {
    case "flower_bed":
      return "Flower / veggie beds";
    case "ground_cover":
      return "Ground cover";
    case "lawn":
      return "Lawn";
    case "trees":
      return "Trees / shrubs";
    default:
      return value;
  }
}

export function IrrigationZoneWizard({
  open,
  mode,
  initialZone,
  onClose,
  onCreated,
  onUpdated,
  createZone,
  updateZone,
}: {
  open: boolean;
  mode: "create" | "edit";
  initialZone?: IrrigationZone | null;
  onClose: () => void;
  onCreated?: (zone: IrrigationZone) => void;
  onUpdated?: (zone: IrrigationZone) => void;
  createZone: (payload: CreateIrrigationZonePayload) => Promise<IrrigationZone>;
  updateZone: (zoneId: string, payload: CreateIrrigationZonePayload) => Promise<IrrigationZone>;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEditing = mode === "edit" && Boolean(initialZone);

  useEffect(() => {
    if (!open) {
      return;
    }
    setStepIndex(0);
    setError(null);
    setSubmitting(false);
    if (mode === "edit" && initialZone) {
      setState({
        irrigationType: initialZone.irrigation_type,
        sunExposure: initialZone.sun_exposure,
        slope: initialZone.slope,
        plantingType: initialZone.planting_type,
        name: initialZone.name,
        coverage: initialZone.coverage_sq_ft > 0 ? String(initialZone.coverage_sq_ft) : "",
        description: initialZone.description ?? "",
      });
    } else {
      setState(INITIAL_STATE);
    }
  }, [open, mode, initialZone]);

  const currentStep = STEP_SEQUENCE[stepIndex] ?? STEP_SEQUENCE[0];
  const totalSteps = STEP_SEQUENCE.length;
  const headerPrompt =
    currentStep.id === "review" && isEditing
      ? "Review and update this zone."
      : currentStep.id === "name" && isEditing
      ? "Update the zone name and coverage."
      : currentStep.prompt;

  const canProceed = useMemo(() => {
    switch (currentStep.id) {
      case "irrigation":
        return state.irrigationType !== null;
      case "sun":
        return state.sunExposure !== null;
      case "slope":
        return state.slope !== null;
      case "planting":
        return state.plantingType !== null;
      case "name":
        return state.name.trim().length > 0;
      case "review":
        return true;
      default:
        return false;
    }
  }, [currentStep.id, state]);

  const summaryDescription = useMemo(() => {
    if (
      !state.irrigationType ||
      !state.sunExposure ||
      state.slope === null ||
      !state.plantingType
    ) {
      return "";
    }
    const slopeText = state.slope ? "Includes slope" : "Flat grade";
    const typeLabel = state.irrigationType === "drip" ? "Drip" : "Spray";
    return `${typeLabel} zone for ${formatPlantingLabel(state.plantingType)} · ${formatSunLabel(
      state.sunExposure,
    )} · ${slopeText}`;
  }, [state]);

  const reviewDescription = useMemo(() => {
    const trimmed = state.description.trim();
    return trimmed || summaryDescription;
  }, [state.description, summaryDescription]);

  const coverageValue = useMemo(() => {
    const trimmed = state.coverage.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }, [state.coverage]);

  const handleNext = () => {
    if (!canProceed) {
      return;
    }
    setStepIndex((index) => Math.min(index + 1, totalSteps - 1));
    setError(null);
  };

  const handleBack = () => {
    setStepIndex((index) => Math.max(index - 1, 0));
    setError(null);
  };

  const handleSubmit = async () => {
    if (
      !state.irrigationType ||
      !state.sunExposure ||
      state.slope === null ||
      !state.plantingType ||
      !state.name.trim()
    ) {
      return;
    }
    const description = reviewDescription || summaryDescription;
    if (!description) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateIrrigationZonePayload = {
        name: state.name.trim(),
        irrigation_type: state.irrigationType,
        sun_exposure: state.sunExposure,
        slope: Boolean(state.slope),
        planting_type: state.plantingType,
        description,
      };
      if (coverageValue !== undefined) {
        payload.coverage_sq_ft = coverageValue;
      }
      let zone: IrrigationZone;
      if (isEditing && initialZone) {
        zone = await updateZone(initialZone.id, payload);
        onUpdated?.(zone);
      } else {
        zone = await createZone(payload);
        onCreated?.(zone);
      }
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Unable to ${isEditing ? "update" : "create"} zone.`;
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderOptions = () => {
    if (!currentStep.options) {
      return null;
    }
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {currentStep.options.map((option) => {
          const selected =
            (currentStep.id === "irrigation" && state.irrigationType === option.value) ||
            (currentStep.id === "sun" && state.sunExposure === option.value) ||
            (currentStep.id === "slope" && state.slope === option.value) ||
            (currentStep.id === "planting" && state.plantingType === option.value);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                switch (currentStep.id) {
                  case "irrigation":
                    setState((prev) => ({ ...prev, irrigationType: option.value }));
                    break;
                  case "sun":
                    setState((prev) => ({ ...prev, sunExposure: option.value }));
                    break;
                  case "slope":
                    setState((prev) => ({ ...prev, slope: option.value }));
                    break;
                  case "planting":
                    setState((prev) => ({ ...prev, plantingType: option.value }));
                    break;
                  default:
                    break;
                }
              }}
              className={`flex flex-col rounded-xl border px-4 py-3 text-left transition ${
                selected
                  ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-50 shadow-inner shadow-emerald-900/40"
                  : "border-emerald-800/50 bg-[rgba(4,18,12,0.85)] text-emerald-100 hover:border-emerald-600/60 hover:bg-[rgba(6,24,16,0.9)]"
              }`}
            >
              <span className="text-sm font-semibold">{option.label}</span>
              <span className="mt-1 text-xs text-emerald-200/70">{option.description}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const renderStepContent = () => {
    switch (currentStep.id) {
      case "name":
        return (
          <div className="space-y-3">
            <label className="block text-sm text-emerald-200/80">
              <span className="mb-1 block font-medium text-emerald-50">Zone name</span>
              <input
                type="text"
                value={state.name}
                onChange={(event) => setState((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Front drip line"
                className="w-full rounded-lg border border-emerald-700/50 bg-[rgba(6,24,16,0.92)] px-3 py-2 text-sm text-emerald-50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
            </label>
            <label className="block text-xs text-emerald-200/70">
              <span className="mb-1 block font-medium text-emerald-200/70">Approximate coverage (sq ft)</span>
              <input
                type="number"
                min={0}
                value={state.coverage}
                onChange={(event) => setState((prev) => ({ ...prev, coverage: event.target.value }))}
                placeholder="Optional"
                className="w-full rounded-lg border border-emerald-800/50 bg-[rgba(4,18,12,0.9)] px-3 py-2 text-sm text-emerald-50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
              <span className="mt-1 block text-[11px] text-emerald-200/60">
                Helps calculate irrigation runtimes, but you can skip this for now.
              </span>
            </label>
          </div>
        );
      case "review":
        return (
          <div className="space-y-4 rounded-xl border border-emerald-700/40 bg-[rgba(4,18,12,0.88)] p-4 text-sm text-emerald-100">
            <p className="text-base font-semibold text-emerald-50">{state.name.trim()}</p>
            <ul className="space-y-2 text-sm text-emerald-200/80">
              <li>
                <span className="text-emerald-200/60">Delivery:</span>{" "}
                {state.irrigationType === "drip" ? "Drip / micro emitters" : "Spray / sprinklers"}
              </li>
              <li>
                <span className="text-emerald-200/60">Sun:</span> {state.sunExposure ? formatSunLabel(state.sunExposure) : "—"}
              </li>
              <li>
                <span className="text-emerald-200/60">Slope:</span> {state.slope ? "Has slope" : "Flat / no slope"}
              </li>
              <li>
                <span className="text-emerald-200/60">Planting:</span>{" "}
                {state.plantingType ? formatPlantingLabel(state.plantingType) : "—"}
              </li>
              <li>
                <span className="text-emerald-200/60">Coverage:</span>{" "}
                {coverageValue !== undefined ? `${coverageValue} sq ft` : "Not provided"}
              </li>
            </ul>
            <label className="block text-xs text-emerald-200/70">
              <span className="mb-1 block font-medium text-emerald-200/80">Zone description (optional)</span>
              <textarea
                value={state.description}
                onChange={(event) => setState((prev) => ({ ...prev, description: event.target.value }))}
                placeholder={summaryDescription || "Summarize sun, slope, and plant mix for this zone."}
                rows={3}
                maxLength={200}
                className="w-full rounded-lg border border-emerald-800/50 bg-[rgba(3,15,10,0.9)] px-3 py-2 text-sm text-emerald-100 placeholder:text-emerald-200/40 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
              <span className="mt-1 block text-[11px] text-emerald-200/50">Shown alongside the zone name in the picker.</span>
            </label>
            {reviewDescription ? (
              <p className="text-xs text-emerald-200/70">
                Preview: {reviewDescription}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/60 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:border-emerald-400/80 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? (isEditing ? "Saving..." : "Creating...") : isEditing ? "Save changes" : "Create zone"}
              </button>
            </div>
          </div>
        );
      default:
        return renderOptions();
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8">
      <div className="w-full max-w-3xl rounded-2xl border border-emerald-700/50 bg-[rgba(3,15,10,0.95)] shadow-[0_40px_120px_rgba(2,12,8,0.8)]">
        <div className="flex items-center justify-between border-b border-emerald-800/50 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-emerald-200/60">
              Zone Wizard
            </p>
            <h2 className="text-lg font-semibold text-emerald-50">{headerPrompt}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-emerald-700/60 px-3 py-1 text-sm text-emerald-200/80 transition hover:border-emerald-500/60 hover:bg-emerald-500/10"
          >
            Close
          </button>
        </div>

        <div className="px-6 pb-2 pt-4">
          <div className="mb-4 flex items-center gap-3">
            {STEP_SEQUENCE.map((step, index) => {
              const active = index === stepIndex;
              const complete = index < stepIndex;
              return (
                <div key={step.id} className="flex items-center gap-2">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold ${
                      active
                        ? "border-emerald-400 bg-emerald-500/20 text-emerald-50"
                        : complete
                        ? "border-emerald-500/60 bg-emerald-500/30 text-emerald-50"
                        : "border-emerald-800/60 bg-emerald-900/40 text-emerald-200/60"
                    }`}
                  >
                    {index + 1}
                  </div>
                  <span
                    className={`text-xs font-medium uppercase tracking-wide ${
                      active || complete ? "text-emerald-200/80" : "text-emerald-200/50"
                    }`}
                  >
                    {step.title}
                  </span>
                  {index < STEP_SEQUENCE.length - 1 ? (
                    <span className="text-emerald-900">—</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 pb-6">
          <div className="space-y-6">
            {renderStepContent()}
            {currentStep.id !== "review" ? (
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={stepIndex === 0}
                  className="rounded-lg border border-emerald-800/60 px-4 py-2 text-sm text-emerald-200/80 transition hover:border-emerald-600/60 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={!canProceed}
                  className="rounded-lg border border-emerald-500/60 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:border-emerald-400/80 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
