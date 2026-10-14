export interface Timing { preparationSeconds: number; answerSeconds: number }
export const DEFAULT_TIMING: Timing = { preparationSeconds: 15, answerSeconds: 20 };
export function validTiming(value: unknown): value is Timing {
  if (!value || typeof value !== 'object') return false;
  const t = value as Timing;
  return Number.isInteger(t.preparationSeconds) && t.preparationSeconds >= 1 && t.preparationSeconds <= 120 &&
    Number.isInteger(t.answerSeconds) && t.answerSeconds >= 5 && t.answerSeconds <= 30;
}
export function readTiming(raw: string | null): Timing {
  try { const parsed: unknown = JSON.parse(raw ?? 'null'); if (validTiming(parsed)) return { ...parsed }; } catch {}
  return { ...DEFAULT_TIMING };
}
