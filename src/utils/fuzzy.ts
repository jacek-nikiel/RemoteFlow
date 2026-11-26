/**
 * Small fuzzy matcher for the command palette: every query word must match one of the fields
 * (name, host, tags, folder…). A whole substring beats a match at a word start, which beats
 * letters in order ("wp1" → "web-prod-01"). Returns 0 when it does not match.
 */
const wordStart = (s: string, i: number) => i === 0 || /[\s\-_./@:]/.test(s[i - 1]);

function scoreField(query: string, field: string): number {
  if (!field) return 0;
  const f = field.toLowerCase();
  const idx = f.indexOf(query);
  if (idx >= 0) {
    let s = 100 - Math.min(idx, 40);
    if (idx === 0) s += 60;
    else if (wordStart(f, idx)) s += 30;
    if (f.length === query.length) s += 40;
    return s;
  }
  // Letters in order; consecutive letters and word starts score higher
  let qi = 0;
  let s = 0;
  let run = 0;
  for (let i = 0; i < f.length && qi < query.length; i++) {
    if (f[i] === query[qi]) {
      run++;
      s += 2 + run * 2 + (wordStart(f, i) ? 6 : 0);
      qi++;
    } else {
      run = 0;
    }
  }
  return qi === query.length ? Math.min(s, 90) : 0;
}

/** Best score of the query over the fields; fields later in the list count a little less. */
export function fuzzyScore(query: string, fields: string[]): number {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let total = 0;
  for (const w of words) {
    let best = 0;
    fields.forEach((field, i) => {
      const s = scoreField(w, field);
      if (s > 0) best = Math.max(best, s - i * 4);
    });
    if (best <= 0) return 0;
    total += best;
  }
  return total;
}
