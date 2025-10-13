import type { SourceSignals } from "../adapters";
import type { InatSignals } from "../adapters/inat";
import type { PowoSignals } from "../adapters/powo";
import type { CorpusToken } from "../rules/apply-keywords";

export interface AdapterSignalBundle {
  powo?: SourceSignals<PowoSignals>;
  inat?: SourceSignals<InatSignals>;
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
  seasonality?: InatSignals["seasonality"];
  wikipediaSummary?: string;
  bundle: AdapterSignalBundle;
}

export const collectSignalCorpus = (bundle: AdapterSignalBundle): SignalCorpus => {
  const texts: CorpusToken[] = [];
  const habitats: AttributedValue[] = [];
  const lifeforms: AttributedValue[] = [];
  const biomes: AttributedValue[] = [];
  const nativeRegions: AttributedValue[] = [];
  const introducedRegions: AttributedValue[] = [];
  let seasonality: InatSignals["seasonality"];
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
  }

  if (bundle.inat) {
    const inat = bundle.inat.signals;
    const url = bundle.inat.context.url;
    if (inat.seasonality) seasonality = inat.seasonality;
    if (inat.wikipediaSummary) {
      wikipediaSummary = inat.wikipediaSummary;
      texts.push({
        text: inat.wikipediaSummary,
        sourceId: "inat",
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
