import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PlantRecord,
  PlantSuggestion,
  PlantCareProfile,
  PotModel,
  IrrigationZone,
  createPlant,
  detectSmartPot,
  fetchIrrigationZones,
  fetchPlants,
  fetchPotModels,
  suggestPlants,
  fetchPlantDetails,
} from "../api/hubClient";

type CreatePayload = {
  nickname: string;
  species: string;
  locationType: "smart_pot" | "garden";
  potModel?: string | null;
  irrigationZoneId?: string | null;
  imageData?: string | null;
  taxonomy?: Record<string, string> | null;
  summary?: string | null;
  imageUrl?: string | null;
  careProfile?: PlantCareProfile | null;
};

type CatalogState = {
  plants: PlantRecord[];
  potModels: PotModel[];
  irrigationZones: IrrigationZone[];
  loading: boolean;
  error: string | null;
};

export function usePlantCatalog() {
  const [state, setState] = useState<CatalogState>({
    plants: [],
    potModels: [],
    irrigationZones: [],
    loading: false,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [plants, pots, zones] = await Promise.all([
        fetchPlants(controller.signal),
        fetchPotModels(controller.signal),
        fetchIrrigationZones(controller.signal),
      ]);
      setState({ plants, potModels: pots, irrigationZones: zones, loading: false, error: null });
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unable to load plant catalog.";
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);

  const submitPlant = useCallback(
    async (payload: CreatePayload) => {
      const record = await createPlant(
        {
          nickname: payload.nickname,
          species: payload.species,
          location_type: payload.locationType,
          pot_model: payload.potModel,
          irrigation_zone_id: payload.irrigationZoneId,
          image_data: payload.imageData,
          taxonomy: payload.taxonomy ?? undefined,
          summary: payload.summary ?? undefined,
          image_url: payload.imageUrl ?? undefined,
          care_profile: payload.careProfile ?? undefined,
        },
        undefined,
      );
      setState((prev) => ({ ...prev, plants: [...prev.plants, record] }));
      return record;
    },
    [],
  );

  const requestDetection = useCallback(async () => {
    return detectSmartPot();
  }, []);

  const getSuggestions = useCallback(async (search: string) => {
    const term = search.trim();
    if (term.length < 3) {
      return [] as PlantSuggestion[];
    }
    return suggestPlants(term);
  }, []);

  const getDetails = useCallback(async (plantId: string) => {
    return fetchPlantDetails(plantId.trim());
  }, []);

  return useMemo(
    () => ({
      plants: state.plants,
      potModels: state.potModels,
      irrigationZones: state.irrigationZones,
      loading: state.loading,
      error: state.error,
      refresh,
      submitPlant,
      requestDetection,
      getSuggestions,
      getDetails,
    }),
    [state, refresh, submitPlant, requestDetection, getSuggestions, getDetails],
  );
}



