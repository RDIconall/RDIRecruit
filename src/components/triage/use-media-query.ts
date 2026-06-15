"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media-query hook (#5). Returns false on the server and on first paint,
 * then settles to the real match on mount — so server and client markup agree.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** True when the viewport is narrow enough to stack source-reader grids (#5). */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 768px)");
}
