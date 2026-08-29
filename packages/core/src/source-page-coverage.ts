import { extractCitations } from "./wiki/page.js";
import type { WikiPageV1 } from "./wiki/types.js";

/** Returns sources backed by a declared locator and matching inline citation. */
export function catalogedSourceIds(pages: readonly WikiPageV1[]): Set<string> {
  const cataloged = new Set<string>();
  for (const page of pages) {
    if (page.type !== "source") continue;
    const citedLocators = new Map<string, Set<string>>();
    for (const citation of extractCitations(page.body)) {
      if (!citation.locator) continue;
      const locators =
        citedLocators.get(citation.sourceId) ?? new Set<string>();
      locators.add(citation.locator);
      citedLocators.set(citation.sourceId, locators);
    }
    for (const source of page.sources) {
      const citations = citedLocators.get(source.id);
      if (
        citations &&
        source.locators.some(
          (locator) => locator.trim().length > 0 && citations.has(locator),
        )
      ) {
        cataloged.add(source.id);
      }
    }
  }
  return cataloged;
}
