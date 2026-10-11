/** Feature dictionaries: fr defines the shape, en must provide every key. */
export function definePart<T extends Record<string, unknown>>(fr: T, en: T): { fr: T; en: T } {
  return { fr, en };
}
