/**
 * deal-count.js — shared free-text deal-count parser
 *
 * Used by api/intake.js (live in-call, Path C2's deal_count question) and
 * api/ghl-sync.js (post-call, feeds the roadmap generator's deal_count
 * signal). Kept in one place so both paths parse identically.
 */

// deal_count answers arrive as free text ("about 8", "a few", "none yet").
// The PARSED NUMBER (or null) is what feeds the roadmap generator's
// deal_count signal — never a fabricated guess when nothing is parseable, so
// its own null-handling/stage-fallback logic still applies.
export const DEAL_COUNT_WORD_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};
// Rough estimate by phrase, checked only when no digit or number-word is
// found. First match wins. Tunable, same style as OPEN_ENDED_NEED_PATTERNS in
// intake.js — add phrases here as new call transcripts turn up.
export const DEAL_COUNT_PHRASE_MAP = [
  { phrases: ['none yet', "haven't done any", 'havent done any', 'no deals', 'zero deals', 'none'], value: 0 },
  { phrases: ['a few', 'couple', 'some'], value: 2 },
  { phrases: ['several', 'many', 'a bunch'], value: 6 },
  { phrases: ['a lot', 'tons', 'dozens'], value: 15 }
];
const isSet = (v) => typeof v === 'string' && v.trim().length > 0;
export const parseDealCount = (v) => {
  if (!isSet(v)) return null;
  const t = v.toLowerCase();
  const digitMatch = t.match(/\d+/);
  if (digitMatch) return parseInt(digitMatch[0], 10);
  const wordMatch = t.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (wordMatch) return DEAL_COUNT_WORD_NUMBERS[wordMatch[1]];
  const phraseHit = DEAL_COUNT_PHRASE_MAP.find(row => row.phrases.some(p => t.includes(p)));
  return phraseHit ? phraseHit.value : null;
};
