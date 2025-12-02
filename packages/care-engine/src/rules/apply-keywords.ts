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

export interface MatchOptions {
  /**
   * Optional per-source multipliers applied to rule weights.
   */
  sourceWeights?: Record<string, number>;
  /**
   * Negation detector applied around the match window to drop false positives.
   */
  negationPattern?: RegExp;
}

const DEFAULT_NEGATION_PATTERN = /\b(no|not|without|avoid|never|lacking|lack)\b/i;

const isNegated = (text: string, matchIndex: number, matchLength: number, negationPattern: RegExp): boolean => {
  const windowStart = Math.max(0, matchIndex - 32);
  const windowEnd = Math.min(text.length, matchIndex + matchLength + 32);
  const window = text.slice(windowStart, windowEnd);
  return negationPattern.test(window);
};

export const matchKeywordRules = <TValue>(
  corpus: CorpusToken[],
  rules: readonly KeywordRule<TValue>[],
  options: MatchOptions = {}
): KeywordMatch<TValue>[] => {
  const matches: KeywordMatch<TValue>[] = [];
  const sourceWeights = options.sourceWeights ?? {};
  const negationPattern = options.negationPattern ?? DEFAULT_NEGATION_PATTERN;

  for (const token of corpus) {
    if (!token.text) continue;
    for (const rule of rules) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      const found = regex.exec(token.text);
      if (found) {
        const start = typeof found.index === "number" ? found.index : token.text.indexOf(found[0] ?? "");
        const matchText = found[0] ?? "";
        if (isNegated(token.text, Math.max(0, start), matchText.length, negationPattern)) {
          continue;
        }
        const sourceWeight = token.sourceId ? sourceWeights[token.sourceId] ?? 1 : 1;
        matches.push({
          value: rule.value,
          weight: rule.weight * sourceWeight,
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
