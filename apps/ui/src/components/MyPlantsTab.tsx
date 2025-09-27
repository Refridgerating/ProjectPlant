import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlantRecord,
  PlantSuggestion,
  PlantDetails,
  PlantCareProfile,
  PotModel,
  IrrigationZone,
} from "../api/hubClient";
import { usePlantCatalog } from "../hooks/usePlantCatalog";

type FormState = {
  nickname: string;
  species: string;
  locationType: "smart_pot" | "garden";
  potModel?: string | null;
  irrigationZoneId?: string | null;
  imageData?: string | null;
};

type ManualCareState = {
  light: string;
  water: string;
  humidity: string;
  tempLow: string;
  tempHigh: string;
  phLow: string;
  phHigh: string;
  notes: string;
};

const INITIAL_FORM: FormState = {
  nickname: "",
  species: "",
  locationType: "smart_pot",
  potModel: null,
  irrigationZoneId: null,
  imageData: null,
};

const INITIAL_MANUAL_CARE: ManualCareState = {
  light: "",
  water: "",
  humidity: "",
  tempLow: "",
  tempHigh: "",
  phLow: "",
  phHigh: "",
  notes: "",
};
type GalleryImage = {
  url: string;
  label: string;
  origin: "upload" | "reference" | "suggestion";
};




function createManualCareFromProfile(profile: PlantCareProfile): ManualCareState {
  const [tempLow, tempHigh] = profile.temperature_c;
  const [phLow, phHigh] = profile.ph_range;
  return {
    light: profile.light ?? "",
    water: profile.water ?? "",
    humidity: profile.humidity ?? "",
    tempLow: Number.isFinite(tempLow) ? String(tempLow) : "",
    tempHigh: Number.isFinite(tempHigh) ? String(tempHigh) : "",
    phLow: Number.isFinite(phLow) ? String(phLow) : "",
    phHigh: Number.isFinite(phHigh) ? String(phHigh) : "",
    notes: profile.notes ?? "",
  };
}

const LOCATION_OPTIONS: ReadonlyArray<{ id: "smart_pot" | "garden"; label: string }> = [
  { id: "smart_pot", label: "Smart Pot" },
  { id: "garden", label: "Outdoor Garden" },
];

const MIN_QUERY_LENGTH = 3;

function sanitizeSummary(input?: string | null): string {
  if (!input) {
    return "";
  }
  try {
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      const doc = parser.parseFromString(input, "text/html");
      const text = doc.body.textContent ?? "";
      return text.replace(/\s+/g, " ").trim();
    }
  } catch {
    // ignore DOMParser errors and fall back to regex cleanup
  }
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function MyPlantsTab() {
  const {
    plants,
    potModels,
    irrigationZones,
    loading,
    error,
    refresh,
    submitPlant,
    requestDetection,
    getSuggestions,
    getDetails,
  } = usePlantCatalog();

  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [manualCare, setManualCare] = useState<ManualCareState>({ ...INITIAL_MANUAL_CARE });
  const [manualSeed, setManualSeed] = useState<string | null>(null);
  const [manualOverrides, setManualOverrides] = useState(false);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const lightboxActiveRef = useRef(isLightboxOpen);
  const [suggestions, setSuggestions] = useState<PlantSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [detail, setDetail] = useState<PlantDetails | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detectionState, setDetectionState] = useState<{ pending: boolean; model: PotModel | null }>({
    pending: false,
    model: null,
  });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    lightboxActiveRef.current = isLightboxOpen;
  }, [isLightboxOpen]);

  // Suggest species based on user input
  useEffect(() => {
    const term = form.species.trim();
    if (term.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }
    setSuggestionsLoading(true);
    const handle = window.setTimeout(() => {
      getSuggestions(term)
        .then((items) => setSuggestions(items))
        .catch(() => setSuggestions([]))
        .finally(() => setSuggestionsLoading(false));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [form.species, getSuggestions]);

  // Smart pot detection when relevant tab selected
  useEffect(() => {
    if (form.locationType === "smart_pot") {
      setDetectionState((prev) => ({ ...prev, pending: true }));
      requestDetection()
        .then((model) => {
          setDetectionState({ pending: false, model });
          setForm((prev) => ({ ...prev, potModel: model.id }));
        })
        .catch(() => setDetectionState({ pending: false, model: null }));
    } else {
      setDetectionState({ pending: false, model: null });
      setForm((prev) => ({ ...prev, potModel: null }));
    }
  }, [form.locationType, requestDetection]);

  useEffect(() => {
    if (!detail) {
      if (manualSeed !== null) {
        setManualCare({ ...INITIAL_MANUAL_CARE });
        setManualSeed(null);
      }
      setManualOverrides(false);
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
      return;
    }
    const nextSeed = detail.scientific_name.toLowerCase();
    if (nextSeed !== manualSeed) {
      setManualCare(createManualCareFromProfile(detail.care));
      setManualSeed(nextSeed);
      setManualOverrides(false);
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
    }
  }, [detail, manualSeed]);

  const handleSpeciesChange = (value: string) => {
    setForm((prev) => ({ ...prev, species: value }));
    setDetail(null);
    setDetailError(null);
    setPreviewImageUrl(null);
    setActiveImageIndex(0);
    setIsLightboxOpen(false);
  };

  const handleLocationChange = (next: FormState["locationType"]) => {
    setForm((prev) => ({
      ...prev,
      locationType: next,
      potModel: next === "smart_pot" ? prev.potModel : null,
      irrigationZoneId: next === "garden" ? prev.irrigationZoneId : null,
    }));
  };

  const handleSuggestionClick = async (suggestion: PlantSuggestion) => {
    setForm((prev) => ({ ...prev, species: suggestion.scientific_name }));
    setSuggestions([]);
    setPreviewImageUrl(suggestion.image_url ?? null);
    setActiveImageIndex(0);
    setIsLightboxOpen(false);
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const fetched = await getDetails(suggestion.id);
      setDetail(fetched);
      setPreviewImageUrl((prev) => fetched.image_url ?? prev);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load plant details.";
      setDetailError(message);
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setForm((prev) => ({ ...prev, imageData: null }));
      setPreviewImageUrl(detail?.image_url ?? null);
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((prev) => ({ ...prev, imageData: typeof reader.result === "string" ? reader.result : null }));
      setPreviewImageUrl(null);
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
    };
    reader.readAsDataURL(file);
  };

  const handleManualCareChange = (field: keyof ManualCareState, value: string) => {
    setManualOverrides(true);
    setManualCare((prev) => ({ ...prev, [field]: value }));
  };

  const buildCareProfile = (): PlantCareProfile | null => {
    const trimmedInitialNotes = manualCare.notes.trim();
    const base: PlantCareProfile | null = detail?.care
      ? { ...detail.care }
      : {
          light: manualCare.light || "Specify light",
          water: manualCare.water || "Specify watering",
          humidity: manualCare.humidity || "Average humidity",
          temperature_c: [18, 26],
          ph_range: [6, 7],
          notes: trimmedInitialNotes || null,
          level: "custom",
          source: null,
          warning: detail?.care.warning ?? null,
          allow_user_input: true,
        };

    if (!base) {
      return null;
    }

    let hasOverrides = manualOverrides;

    if (!detail || manualOverrides) {
      if (manualCare.light.trim()) {
        base.light = manualCare.light.trim();
        hasOverrides = true;
      }
      if (manualCare.water.trim()) {
        base.water = manualCare.water.trim();
        hasOverrides = true;
      }
      if (manualCare.humidity.trim()) {
        base.humidity = manualCare.humidity.trim();
        hasOverrides = true;
      }
      const trimmedNotes = manualCare.notes.trim();
      if (manualOverrides || trimmedNotes) {
        base.notes = trimmedNotes || null;
        hasOverrides = true;
      }
      const lowTemp = parseFloat(manualCare.tempLow);
      const highTemp = parseFloat(manualCare.tempHigh);
      if (!Number.isNaN(lowTemp) && !Number.isNaN(highTemp)) {
        base.temperature_c = [lowTemp, highTemp];
        hasOverrides = true;
      }
      const lowPh = parseFloat(manualCare.phLow);
      const highPh = parseFloat(manualCare.phHigh);
      if (!Number.isNaN(lowPh) && !Number.isNaN(highPh)) {
        base.ph_range = [lowPh, highPh];
        hasOverrides = true;
      }
    }

    if (!detail) {
      hasOverrides = true;
    }

    if (hasOverrides) {
      base.level = "custom";
      base.source = base.source ?? "user";
    }

    return base;
  };



  const handleResetManualCare = () => {
    if (detail) {
      setManualCare(createManualCareFromProfile(detail.care));
      setManualOverrides(false);
      setManualSeed(detail.scientific_name.toLowerCase());
    } else {
      setManualCare({ ...INITIAL_MANUAL_CARE });
      setManualOverrides(false);
      setManualSeed(null);
    }
  };
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.species.trim()) {
      setStatusMessage("Please specify a plant species.");
      return;
    }

    const careProfile = buildCareProfile();
    if (!careProfile) {
      setStatusMessage("Unable to build care profile. Provide more information.");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const record = await submitPlant({
        nickname: form.nickname.trim() || form.species,
        species: form.species.trim(),
        locationType: form.locationType,
        potModel: form.locationType === "smart_pot" ? form.potModel ?? detectionState.model?.id ?? null : null,
        irrigationZoneId: form.locationType === "garden" ? form.irrigationZoneId ?? null : null,
        imageData: form.imageData ?? null,
        taxonomy: detail?.taxonomy ?? null,
        summary: detail?.summary ?? null,
        imageUrl: detail?.image_url ?? null,
        careProfile,
      });
      setStatusMessage(`Saved ${record.nickname}`);
      setForm(INITIAL_FORM);
      setManualCare({ ...INITIAL_MANUAL_CARE });
      setManualOverrides(false);
      setManualSeed(null);
      setPreviewImageUrl(null);
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
      setDetail(null);
      setSuggestions([]);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to save plant.";
      setStatusMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const galleryImages = useMemo(() => {
    const items: GalleryImage[] = [];
    const seen = new Set<string>();
    const register = (url: string | null | undefined, label: string, origin: GalleryImage['origin']) => {
      if (typeof url !== 'string') {
        return;
      }
      const trimmed = url.trim();
      if (!trimmed || seen.has(trimmed) || items.length >= 10) {
        return;
      }
      seen.add(trimmed);
      items.push({ url: trimmed, label, origin });
    };

    if (form.imageData) {
      register(form.imageData, 'Uploaded photo', 'upload');
    }

    const referenceImages = detail?.images ?? [];
    if (referenceImages.length) {
      const referenceLabel = detail?.sources?.length
        ? `${detail?.sources?.join(' + ')} reference`
        : 'Reference image';
      for (const url of referenceImages) {
        register(url, referenceLabel, 'reference');
        if (items.length >= 10) {
          break;
        }
      }
    }

    if (previewImageUrl) {
      register(previewImageUrl, 'Suggestion preview', 'suggestion');
    }

    return items;
  }, [detail?.images, detail?.sources, form.imageData, previewImageUrl]);

  useEffect(() => {
    if (!galleryImages.length) {
      setActiveImageIndex(0);
      setIsLightboxOpen(false);
      return;
    }
    setActiveImageIndex((prev) => (prev >= galleryImages.length ? 0 : prev));
  }, [galleryImages]);

  const activeImage = galleryImages[activeImageIndex] ?? null;
  const previewImage = activeImage?.url ?? null;
  const previewLabel = activeImage?.label ?? '';
  const previewTitle = detail?.scientific_name || form.species || "Plant preview";


  const cycleGallery = useCallback((direction: 1 | -1) => {
    if (!galleryImages.length) {
      return;
    }
    setActiveImageIndex((prev) => {
      const length = galleryImages.length;
      return (prev + direction + length) % length;
    });
  }, [galleryImages]);

  const openLightbox = useCallback(() => {
    if (activeImage) {
      setIsLightboxOpen(true);
    }
  }, [activeImage]);

  const closeLightbox = useCallback(() => {
    setIsLightboxOpen(false);
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!lightboxActiveRef.current) {
        return;
      }
      if (event.key === 'Escape') {
        setIsLightboxOpen(false);
      } else if (event.key === 'ArrowRight') {
        cycleGallery(1);
      } else if (event.key === 'ArrowLeft') {
        cycleGallery(-1);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [cycleGallery]);

  const baseCareProfile = detail?.care ?? null;


  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Add a plant</h2>
            <p className="mt-1 text-sm text-slate-400">
              Search for a species to pull taxonomy, imagery, and care guidance. Smart pots auto-detect their vessel; garden plants can be linked to an irrigation zone.
            </p>
          </div>
          {detectionState.model ? (
            <div className="rounded-lg border border-cyan-500/50 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              <p className="font-semibold">Detected pot</p>
              <p>{detectionState.model.name}</p>
            </div>
          ) : null}
        </header>

        <form className="mt-6 grid gap-5 lg:grid-cols-2" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <label className="block text-sm text-slate-300">
              <span className="mb-1 block font-medium text-slate-200">Plant nickname</span>
              <input
                value={form.nickname}
                onChange={(event) => setForm((prev) => ({ ...prev, nickname: event.target.value }))}
                placeholder="Living room monstera"
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
            </label>
            <label className="block text-sm text-slate-300">
              <span className="mb-1 block font-medium text-slate-200">Species</span>
              <input
                value={form.species}
                onChange={(event) => handleSpeciesChange(event.target.value)}
                placeholder="Monstera deliciosa"
                className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                autoComplete="off"
              />
            </label>
            {suggestionsLoading ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 text-xs text-slate-400">
                Searching botanical records...
              </div>
            ) : suggestions.length ? (
              <ul className="rounded-lg border border-slate-800 bg-slate-900/80 text-xs text-slate-300">
                {suggestions.map((item) => (
                  <li key={`${item.id}-${item.scientific_name}`}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-800/80"
                      onClick={() => void handleSuggestionClick(item)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border border-slate-700 bg-slate-800/60">
                          {item.image_url ? (
                            <img src={item.image_url} alt={item.common_name ?? item.scientific_name} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-wide text-slate-500">
                              No image
                            </div>
                          )}
                        </div>
                        <div className="flex flex-1 flex-col gap-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-semibold text-slate-100">{item.common_name ?? item.scientific_name}</p>
                            <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                              {item.sources && item.sources.length ? item.sources.join(" + ") : "guide"}
                            </span>
                          </div>
                          <p className="text-[11px] uppercase tracking-wide text-slate-400">{item.scientific_name}</p>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-3">
              <span className="block text-sm font-medium text-slate-200">Location</span>
              <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900/60 p-1 text-xs font-semibold">
                {LOCATION_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleLocationChange(option.id)}
                    className={`rounded-md px-3 py-2 transition-colors ${
                      form.locationType === option.id
                        ? "bg-brand-500/20 text-brand-100 shadow"
                        : "text-slate-400 hover:text-slate-100"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {form.locationType === "smart_pot" ? (
              <div className="space-y-2 text-sm text-slate-300">
                <label className="block">
                  <span className="mb-1 block font-medium text-slate-200">Pot model</span>
                  <select
                    value={form.potModel ?? ""}
                    onChange={(event) => setForm((prev) => ({ ...prev, potModel: event.target.value || null }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                  >
                    <option value="">Auto detect</option>
                    {potModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-slate-500">
                  {detectionState.pending
                    ? "Scanning smart pot sensors..."
                    : detectionState.model
                    ? `Detected ${detectionState.model.name}`
                    : "Select a model or rely on auto detection."}
                </p>
              </div>
            ) : (
              <label className="block text-sm text-slate-300">
                <span className="mb-1 block font-medium text-slate-200">Irrigation zone</span>
                <select
                  value={form.irrigationZoneId ?? ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, irrigationZoneId: event.target.value || null }))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  <option value="">Select a zone</option>
                  {irrigationZones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block text-sm text-slate-300">
              <span className="mb-1 block font-medium text-slate-200">Plant photo</span>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="w-full text-xs text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-brand-500/20 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-brand-100 hover:file:bg-brand-500/30"
              />
              <p className="mt-1 text-xs text-slate-500">Optional. Remote imagery is used when available.</p>
            </label>
          </div>

          <div className="space-y-4">
            {previewImage ? (
              <div className="relative flex min-h-[260px] items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/60">
                <button
                  type="button"
                  onClick={openLightbox}
                  className="group flex h-full w-full items-center justify-center focus:outline-none"
                >
                  <img
                    src={previewImage}
                    alt={previewLabel || "Plant reference image"}
                    className="max-h-[360px] w-full object-contain transition-transform duration-150 group-hover:scale-[1.01]"
                  />
                  <span className="sr-only">Open full-screen preview</span>
                </button>
                {galleryImages.length > 1 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => cycleGallery(-1)}
                      className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 text-slate-200 hover:border-slate-500 hover:text-white"
                      aria-label="Previous photo"
                    >
                      {'<'}
                    </button>
                    <button
                      type="button"
                      onClick={() => cycleGallery(1)}
                      className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 text-slate-200 hover:border-slate-500 hover:text-white"
                      aria-label="Next photo"
                    >
                      {'>'}
                    </button>
                  </>
                ) : null}
                {previewLabel ? (
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-slate-900/80 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-300">
                    {previewLabel}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-xs text-slate-500">
                Plant preview will appear here
              </div>
            )}
            {galleryImages.length > 1 ? (
              <div className="flex gap-2 overflow-x-auto pt-2">
                {galleryImages.map((image, index) => (
                  <button
                    key={image.url}
                    type="button"
                    onClick={() => {
                      setActiveImageIndex(index);
                      setIsLightboxOpen(false);
                    }}
                    className={`relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border ${index === activeImageIndex ? 'border-brand-400 shadow shadow-brand-500/40' : 'border-slate-700 hover:border-slate-500'}`}
                    aria-label={image.label || `Preview image ${index + 1}`}
                  >
                    <img src={image.url} alt={image.label || `Preview image ${index + 1}`} className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            ) : null}

            {loadingDetail ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-300">
                Fetching plant profile...
              </div>
            ) : detail ? (
              <BotanicalSnippet detail={detail} />
            ) : detailError ? (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">{detailError}</div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400">
                Enter a species name to see taxonomy, imagery, and guidance.
              </div>
            )}

            {baseCareProfile ? (
              <CareSummary care={baseCareProfile} title="OpenFarm suggested care" />
            ) : null}
            <ManualCareEditor
              manualCare={manualCare}
              onChange={handleManualCareChange}
              onReset={detail ? handleResetManualCare : undefined}
              baseProfile={baseCareProfile}
              hasOverrides={manualOverrides}
            />

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center justify-center rounded-lg border border-brand-500/60 bg-brand-500/20 px-4 py-2 text-sm font-semibold text-brand-100 transition-colors hover:bg-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "Saving..." : "Save plant"}
            </button>
            {statusMessage ? <p className="text-xs text-slate-400">{statusMessage}</p> : null}
          </div>
        </form>
      </section>

      <section className="space-y-4">
        <header className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">My plants</h3>
          <button type="button" onClick={refresh} className="text-xs font-semibold text-slate-400 hover:text-slate-100">
            Refresh list
          </button>
        </header>
        {loading ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">Loading catalog...</div>
        ) : error ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
        ) : plants.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plants.map((plant) => (
              <PlantCard key={plant.id} plant={plant} potModels={potModels} zones={irrigationZones} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
            No plants yet. Add your first plant to see it here with taxonomy and care guidance.
          </div>
        )}
      </section>
      {isLightboxOpen && activeImage ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95" onClick={closeLightbox}>
          <div className="flex items-center justify-between px-6 py-4 text-slate-200" onClick={(event) => event.stopPropagation()}>
            <p className="text-sm font-semibold">
              {previewTitle}
            </p>
            <button
              type="button"
              onClick={closeLightbox}
              className="rounded-md border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-500 hover:text-white"
            >
              Close
            </button>
          </div>
          <div className="relative flex flex-1 items-center justify-center px-6 pb-6" onClick={(event) => event.stopPropagation()}>
            <img
              src={activeImage.url}
              alt={activeImage.label || "Plant reference image"}
              className="max-h-full max-w-full object-contain"
            />
            {galleryImages.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => cycleGallery(-1)}
                  className="absolute left-6 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 text-slate-200 hover:border-slate-500 hover:text-white"
                  aria-label="Previous photo"
                >
                  {'<'}
                </button>
                <button
                  type="button"
                  onClick={() => cycleGallery(1)}
                  className="absolute right-6 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-900/60 text-slate-200 hover:border-slate-500 hover:text-white"
                  aria-label="Next photo"
                >
                  {'>'}
                </button>
              </>
            ) : null}
          </div>
          {activeImage?.label ? (
            <div className="px-6 pb-6 text-center text-xs text-slate-300" onClick={(event) => event.stopPropagation()}>
              {activeImage.label}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BotanicalSnippet({ detail }: { detail: PlantDetails }) {
  const summaryText = sanitizeSummary(detail.summary);
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-slate-100">{detail.scientific_name}</h3>
        {detail.common_name ? <p className="text-xs uppercase tracking-wide text-slate-400">{detail.common_name}</p> : null}
      </header>
      {summaryText ? <p className="mt-3 text-xs text-slate-400">{summaryText}</p> : null}
      <dl className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
        {detail.taxonomy.family ? <SnippetRow label="Family" value={detail.taxonomy.family} /> : null}
        {detail.taxonomy.genus ? <SnippetRow label="Genus" value={detail.taxonomy.genus} /> : null}
        {detail.rank ? <SnippetRow label="Rank" value={detail.rank} /> : null}
        {detail.sources.length ? <SnippetRow label="Sources" value={detail.sources.join(", ")} /> : null}
      </dl>
      {detail.synonyms.length ? (
        <div className="mt-3 text-xs text-slate-400">
          <p className="font-semibold text-slate-200">Synonyms</p>
          <p>{detail.synonyms.join(", ")}</p>
        </div>
      ) : null}
      {detail.distribution.length ? (
        <div className="mt-2 text-xs text-slate-400">
          <p className="font-semibold text-slate-200">Distribution</p>
          <p>{detail.distribution.join(", ")}</p>
        </div>
      ) : null}
    </section>
  );
}

function ManualCareEditor({
  manualCare,
  onChange,
  baseProfile,
  onReset,
  hasOverrides,
}: {
  manualCare: ManualCareState;
  onChange: (field: keyof ManualCareState, value: string) => void;
  baseProfile?: PlantCareProfile | null;
  onReset?: () => void;
  hasOverrides: boolean;
}) {
  const description = baseProfile
    ? "OpenFarm suggestions are loaded. Adjust any fields to customise care for your space."
    : "Species-specific care was not available. Enter instructions so ProjectPlant can automate the routine.";

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Customise care</h3>
        {baseProfile && onReset ? (
          <button
            type="button"
            onClick={onReset}
            disabled={!hasOverrides}
            className="rounded-md border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reset suggestions
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-slate-400">{description}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs uppercase tracking-wide text-slate-500">
          Light
          <input
            value={manualCare.light}
            onChange={(event) => onChange("light", event.target.value)}
            placeholder="Bright indirect"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </label>
        <label className="text-xs uppercase tracking-wide text-slate-500">
          Water
          <input
            value={manualCare.water}
            onChange={(event) => onChange("water", event.target.value)}
            placeholder="Allow top inch to dry"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </label>
        <label className="text-xs uppercase tracking-wide text-slate-500">
          Humidity
          <input
            value={manualCare.humidity}
            onChange={(event) => onChange("humidity", event.target.value)}
            placeholder="60-70%"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs uppercase tracking-wide text-slate-500">
            Temp low (deg C)
            <input
              value={manualCare.tempLow}
              onChange={(event) => onChange("tempLow", event.target.value)}
              placeholder="18"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </label>
          <label className="text-xs uppercase tracking-wide text-slate-500">
            Temp high (deg C)
            <input
              value={manualCare.tempHigh}
              onChange={(event) => onChange("tempHigh", event.target.value)}
              placeholder="26"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs uppercase tracking-wide text-slate-500">
            pH low
            <input
              value={manualCare.phLow}
              onChange={(event) => onChange("phLow", event.target.value)}
              placeholder="6"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </label>
          <label className="text-xs uppercase tracking-wide text-slate-500">
            pH high
            <input
              value={manualCare.phHigh}
              onChange={(event) => onChange("phHigh", event.target.value)}
              placeholder="7"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </label>
        </div>
      </div>
      <label className="mt-3 block text-xs uppercase tracking-wide text-slate-500">
        Notes
        <textarea
          value={manualCare.notes}
          onChange={(event) => onChange("notes", event.target.value)}
          placeholder="Add fertiliser reminders, pruning notes, etc."
          rows={3}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
      </label>
    </section>
  );
}

function CareSummary({ care, title }: { care: PlantCareProfile; title: string }) {
  return (
    <section className="rounded-xl border border-brand-500/40 bg-brand-500/10 p-4 text-sm text-brand-50">
      <h3 className="text-sm font-semibold text-brand-100">{title}</h3>
      {care.warning ? <p className="mt-1 text-xs text-amber-200">{care.warning}</p> : null}
      <dl className="mt-3 space-y-2">
        <InfoRow label="Sun" value={care.light} />
        <InfoRow label="Watering" value={care.water} />
        {care.soil ? <InfoRow label="Soil" value={care.soil} /> : null}
        {care.spacing ? <InfoRow label="Spacing" value={care.spacing} /> : null}
        {care.lifecycle ? <InfoRow label="Lifecycle" value={care.lifecycle} /> : null}
        <InfoRow label="Humidity" value={care.humidity} />
        <InfoRow label="Temperature" value={`${care.temperature_c[0]}-${care.temperature_c[1]} deg C`} />
        <InfoRow label="pH" value={`${care.ph_range[0]}-${care.ph_range[1]}`} />
        {care.notes ? <InfoRow label="Notes" value={care.notes} /> : null}
      </dl>
      <p className="mt-2 text-[11px] uppercase tracking-wide text-brand-200/70">
        Source: {care.source ?? "ProjectPlant defaults"} ({care.level})
      </p>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-brand-200/80">{label}</p>
      <p className="text-sm text-brand-50">{value}</p>
    </div>
  );
}

function PlantCard({ plant, potModels, zones }: { plant: PlantRecord; potModels: PotModel[]; zones: IrrigationZone[] }) {
  const potName = plant.pot_model
    ? potModels.find((model) => model.id === plant.pot_model)?.name ?? plant.pot_model
    : "-";
  const zoneName = plant.irrigation_zone_id
    ? zones.find((zone) => zone.id === plant.irrigation_zone_id)?.name ?? plant.irrigation_zone_id
    : "-";
  const cardImage = plant.image_url ?? plant.image_data ?? null;
  const summaryText = sanitizeSummary(plant.summary);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
      {cardImage ? (
        <img src={cardImage} alt={plant.nickname} className="h-40 w-full object-cover" />
      ) : (
        <div className="flex h-40 items-center justify-center bg-slate-900/80 text-xs text-slate-500">No photo</div>
      )}
      <div className="space-y-3 p-4 text-sm text-slate-300">
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold text-slate-100">{plant.nickname}</p>
          <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-400">
            {plant.location_type === "smart_pot" ? "Smart Pot" : "Garden"}
          </span>
        </div>
        <p className="text-xs text-slate-400">{plant.species}</p>
        <dl className="space-y-1 text-xs text-slate-400">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Pot model</dt>
            <dd className="text-slate-200">{potName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Irrigation zone</dt>
            <dd className="text-slate-200">{zoneName}</dd>
          </div>
        </dl>
        {Object.keys(plant.taxonomy).length ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 text-xs text-slate-300">
            <p className="font-semibold text-slate-100">Taxonomy</p>
            <ul className="mt-2 space-y-1">
              {Object.entries(plant.taxonomy).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-2">
                  <span className="text-slate-500 capitalize">{key}</span>
                  <span className="text-slate-200">{value}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 text-xs text-slate-300">
          <p className="font-semibold text-slate-100">Ideal conditions ({plant.care_level})</p>
          <ul className="mt-2 space-y-1">
            <li>Light: {plant.ideal_conditions.light}</li>
            <li>Water: {plant.ideal_conditions.water}</li>
            <li>Humidity: {plant.ideal_conditions.humidity}</li>
            <li>
              Temperature: {plant.ideal_conditions.temperature_c[0]}-{plant.ideal_conditions.temperature_c[1]} deg C
            </li>
            <li>pH: {plant.ideal_conditions.ph_range[0]}-{plant.ideal_conditions.ph_range[1]}</li>
            {plant.ideal_conditions.notes ? <li>Notes: {plant.ideal_conditions.notes}</li> : null}
          </ul>
          {plant.care_warning ? <p className="mt-2 text-[11px] text-amber-300">{plant.care_warning}</p> : null}
          {plant.care_source ? (
            <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">Source: {plant.care_source}</p>
          ) : null}
        </div>
        {summaryText ? <p className="text-xs text-slate-400">{summaryText}</p> : null}
      </div>
    </div>
  );
}

function SnippetRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}








