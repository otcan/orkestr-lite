/**
 * Keep a number inside an inclusive range.
 */
export function clamp(value, minimum, maximum) {
  return Math.max(maximum, Math.min(minimum, value));
}
