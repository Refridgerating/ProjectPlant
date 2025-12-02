import type { SourceSignals } from "../adapters";
import type { GbifSignals } from "../adapters/gbif";
import type { InatSignals } from "../adapters/inat";
import type { PowoSignals } from "../adapters/powo";
import type { WikipediaSignals } from "../adapters/wikipedia";
import type { CorpusToken } from "../rules/apply-keywords";

export interface AdapterSignalBundle {
  powo?: SourceSignals<PowoSignals>;
  inat?: SourceSignals<InatSignals>;
  gbif?: SourceSignals<GbifSignals>;
  wikipedia?: SourceSignals<WikipediaSignals>;
}

export interface AttributedValue {
  value: string;
  sourceId: string;
  field: string;
  url?: string;
  structured?: boolean;
}

export interface SignalCorpus {
  texts: CorpusToken[];
  habitats: AttributedValue[];
  lifeforms: AttributedValue[];
  biomes: AttributedValue[];
  nativeRegions: AttributedValue[];
  introducedRegions: AttributedValue[];
  seasonality: SeasonalitySignal[];
  wikipediaSummary?: string;
  bundle: AdapterSignalBundle;
}

export interface SeasonalitySignal {
  sourceId: string;
  url?: string;
  histogram: { month: number; observationCount: number }[];
}

export const collectSignalCorpus = (bundle: AdapterSignalBundle): SignalCorpus => {
  const texts: CorpusToken[] = [];
  const habitats: AttributedValue[] = [];
  const lifeforms: AttributedValue[] = [];
  const biomes: AttributedValue[] = [];
  const nativeRegions: AttributedValue[] = [];
  const introducedRegions: AttributedValue[] = [];
  const seasonality: SeasonalitySignal[] = [];
  let wikipediaSummary: string | undefined;

  if (bundle.powo) {
    const powo = bundle.powo.signals;
    const url = bundle.powo.context.url;
    if (powo.habitats) {
      habitats.push(
        ...powo.habitats.map((value) => ({ value, sourceId: "powo", field: "habitat", url, structured: true }))
      );
    }
    if (powo.lifeforms) {
      lifeforms.push(
        ...powo.lifeforms.map((value) => ({ value, sourceId: "powo", field: "lifeform", url, structured: true }))
      );
    }
    if (powo.biome) {
      biomes.push(...powo.biome.map((value) => ({ value, sourceId: "powo", field: "biome", url, structured: true })));
    }
    if (powo.nativeRegions) {
      nativeRegions.push(
        ...powo.nativeRegions.map((value) => ({ value, sourceId: "powo", field: "native_region", url }))
      );
    }
    if (powo.introducedRegions) {
      introducedRegions.push(
        ...powo.introducedRegions.map((value) => ({ value, sourceId: "powo", field: "introduced_region", url }))
      );
    }
    if (powo.textSnippets) {
      for (const snippet of powo.textSnippets) {
        if (snippet.heading) {
          texts.push({
            text: snippet.heading,
            sourceId: "powo",
            url,
            field: `heading:${snippet.heading.slice(0, 32)}`
          });
        }
        if (snippet.text) {
          texts.push({
            text: snippet.text,
            sourceId: "powo",
            url,
            field: snippet.heading ? `body:${snippet.heading.slice(0, 32)}` : "body"
          });
        }
      }
    }
    if (powo.references) {
      for (const reference of powo.references) {
        if (!reference.title) continue;
        texts.push({
          text: reference.title,
          sourceId: "powo",
          url: reference.url ?? url,
          field: "reference:title",
          structured: true
        });
      }
    }
    if (powo.notes) {
      texts.push({
        text: powo.notes,
        sourceId: "powo",
        url,
        field: "notes"
      });
    }
  }

  if (bundle.inat) {
    const inat = bundle.inat.signals;
    const url = bundle.inat.context.url;
    if (inat.seasonality && inat.seasonality.length > 0) {
      seasonality.push({
        sourceId: "inat",
        url,
        histogram: inat.seasonality
      });
    }
    if (inat.wikipediaSummary) {
      wikipediaSummary = inat.wikipediaSummary;
      texts.push({
        text: inat.wikipediaSummary,
        sourceId: "wikipedia",
        url,
        field: "wikipedia_summary"
      });
    }
    if (inat.establishment) {
      for (const record of inat.establishment) {
        if (record.status === "native") {
          nativeRegions.push({
            value: record.placeName ?? String(record.placeId),
            sourceId: "inat",
            url,
            field: "establishment_native"
          });
        } else if (record.status) {
          introducedRegions.push({
            value: record.placeName ?? String(record.placeId),
            sourceId: "inat",
            url,
            field: `establishment_${record.status}`
          });
        }
      }
    }
    if (inat.iconicTaxonName) {
      lifeforms.push({
        value: inat.iconicTaxonName,
        sourceId: "inat",
        url,
        field: "iconic_taxon",
        structured: true
      });
    }
    if (inat.commonName) {
      texts.push({
        text: inat.commonName,
        sourceId: "inat",
        url,
        field: "common_name",
        structured: true
      });
    }
  }

  if (bundle.wikipedia) {
    const wiki = bundle.wikipedia.signals;
    const url = bundle.wikipedia.context.url;
    if (wiki.summary) {
      texts.push({
        text: wiki.summary,
        sourceId: "wikipedia",
        url,
        field: "wikipedia_summary"
      });
    }
    if (wiki.description) {
      texts.push({
        text: wiki.description,
        sourceId: "wikipedia",
        url,
        field: "wikipedia_description",
        structured: true
      });
    }
  }

  if (bundle.gbif) {
    const gbif = bundle.gbif.signals;
    const url = bundle.gbif.context.url;
    if (gbif.habitats) {
      habitats.push(
        ...gbif.habitats.map((entry) => ({
          value: entry.name,
          sourceId: "gbif",
          field: "habitat",
          url,
          structured: true
        }))
      );
    }
    if (gbif.speciesHabitats) {
      habitats.push(
        ...gbif.speciesHabitats.map((name) => ({
          value: name,
          sourceId: "gbif",
          field: "habitat",
          url,
          structured: true
        }))
      );
    }
    if (gbif.seasonality && gbif.seasonality.length > 0) {
      seasonality.push({
        sourceId: "gbif",
        url,
        histogram: gbif.seasonality
      });
    }
    if (typeof gbif.occurrenceCount === "number") {
      texts.push({
        text: `occurrence count: ${gbif.occurrenceCount}`,
        sourceId: "gbif",
        url,
        field: "occurrence_count",
        structured: true
      });
    }
  }

  return {
    texts,
    habitats,
    lifeforms,
    biomes,
    nativeRegions,
    introducedRegions,
    seasonality,
    wikipediaSummary,
    bundle
  };
};
