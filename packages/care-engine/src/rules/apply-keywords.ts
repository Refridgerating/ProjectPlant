import type { KeywordRule } from "./keyword-dictionary";

export interface CorpusToken {
  text: string;
  sourceId: string;
  sourceName?: string;
  url?: string;
  field?: string;
  structured?: boolean;
}

export interface KeywordMatch<TValue> {
  value: TValue;
  weight: number;
  token: CorpusToken;
  rule: KeywordRule<TValue>;
}

export const matchKeywordRules = <TValue>(
  corpus: CorpusToken[],
  rules: readonly KeywordRule<TValue>[]
): KeywordMatch<TValue>[] => {
  const matches: KeywordMatch<TValue>[] = [];

  for (const token of corpus) {
    if (!token.text) continue;
    for (const rule of rules) {
      if (rule.pattern.test(token.text)) {
        matches.push({
          value: rule.value,
          weight: rule.weight,
          token,
          rule
        });
      }
    }
  }

  return matches;
};

export const aggregateMatches = <TValue>(
  matches: KeywordMatch<TValue>[]
): Map<TValue, { weight: number; examples: KeywordMatch<TValue>[] }> => {
  const map = new Map<TValue, { weight: number; examples: KeywordMatch<TValue>[] }>();
  for (const match of matches) {
    const current = map.get(match.value);
    if (!current) {
      map.set(match.value, { weight: match.weight, examples: [match] });
    } else {
      current.weight += match.weight;
      current.examples.push(match);
    }
  }
  return map;
};
