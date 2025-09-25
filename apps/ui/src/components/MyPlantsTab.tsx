import { ChangeEvent, FormEvent, useEffect, useState } from "react";
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

const LOCATION_OPTIONS: ReadonlyArray<{ id: "smart_pot" | "garden"; label: string }> = [
  { id: "smart_pot", label: "Smart Pot" },
  { id: "garden", label: "Outdoor Garden" },
];

const MIN_QUERY_LENGTH = 3;

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
  const [manualCare, setManualCare] = useState<ManualCareState>(INITIAL_MANUAL_CARE);
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

  const handleSpeciesChange = (value: string) => {
    setForm((prev) => ({ ...prev, species: value }));
    setDetail(null);
    setDetailError(null);
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
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const fetched = await getDetails(suggestion.scientific_name);
      setDetail(fetched);
      setManualCare(INITIAL_MANUAL_CARE);
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
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((prev) => ({ ...prev, imageData: typeof reader.result === "string" ? reader.result : null }));
    };
    reader.readAsDataURL(file);
  };

  const handleManualCareChange = (field: keyof ManualCareState, value: string) => {
    setManualCare((prev) => ({ ...prev, [field]: value }));
  };

  const buildCareProfile = (): PlantCareProfile | null => {
    const base: PlantCareProfile | null = detail?.care
      ? { ...detail.care }
      : {
          light: manualCare.light || "Specify light",
          water: manualCare.water || "Specify watering",
          humidity: manualCare.humidity || "Average humidity",
          temperature_c: [18, 26],
          ph_range: [6, 7],
          notes: manualCare.notes || null,
          level: "custom",
          source: null,
          warning: detail?.care.warning,
          allow_user_input: true,
        };

    if (!base) {
      return null;
    }

    let hasOverrides = false;

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
    if (manualCare.notes.trim()) {
      base.notes = manualCare.notes.trim();
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

    if (!detail) {
      hasOverrides = true;
    }

    if (hasOverrides) {
      base.level = "custom";
      base.source = base.source ?? "user";
    }

    return base;
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
      setManualCare(INITIAL_MANUAL_CARE);
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

  const previewImage = detail?.image_url ?? form.imageData ?? null;
  const previewLabel = detail?.image_url ? "Reference image" : form.imageData ? "Uploaded photo" : "";
  const allowManualCare = !detail || detail.care.level !== "species" || detail.care.allow_user_input;
  const activeCare = detail?.care ?? null;

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
                  <li key={`${item.source}-${item.scientific_name}`}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-800/80"
                      onClick={() => void handleSuggestionClick(item)}
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-slate-100">{item.common_name ?? item.scientific_name}</p>
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                          {item.source}
                        </span>
                      </div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">{item.scientific_name}</p>
                      {item.summary ? <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">{item.summary}</p> : null}
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
              <div className="overflow-hidden rounded-xl border border-slate-800">
                <img src={previewImage} alt="Plant preview" className="h-48 w-full object-cover" />
                {previewLabel ? (
                  <p className="bg-slate-900/70 px-3 py-1 text-[11px] uppercase tracking-wide text-slate-400">{previewLabel}</p>
                ) : null}
              </div>
            ) : (
              <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-xs text-slate-500">
                Plant preview will appear here
              </div>
            )}

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

            {allowManualCare ? (
              <ManualCareEditor manualCare={manualCare} onChange={handleManualCareChange} />
            ) : activeCare ? (
              <CareSummary care={activeCare} title="Suggested care" />
            ) : null}

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
    </div>
  );
}

function BotanicalSnippet({ detail }: { detail: PlantDetails }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
      <header className="space-y-1">
        <h3 className="text-base font-semibold text-slate-100">{detail.scientific_name}</h3>
        {detail.common_name ? <p className="text-xs uppercase tracking-wide text-slate-400">{detail.common_name}</p> : null}
      </header>
      {detail.summary ? <p className="mt-3 text-xs text-slate-400">{detail.summary}</p> : null}
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

function ManualCareEditor({ manualCare, onChange }: { manualCare: ManualCareState; onChange: (field: keyof ManualCareState, value: string) => void }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
      <h3 className="text-sm font-semibold text-slate-200">Customise care</h3>
      <p className="mt-1 text-xs text-slate-400">
        Species-specific care was not available. Enter instructions so ProjectPlant can automate the routine.
      </p>
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
            Temp low (°C)
            <input
              value={manualCare.tempLow}
              onChange={(event) => onChange("tempLow", event.target.value)}
              placeholder="18"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </label>
          <label className="text-xs uppercase tracking-wide text-slate-500">
            Temp high (°C)
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
        <InfoRow label="Light" value={care.light} />
        <InfoRow label="Water" value={care.water} />
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
        {plant.summary ? <p className="text-xs text-slate-400">{plant.summary}</p> : null}
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





