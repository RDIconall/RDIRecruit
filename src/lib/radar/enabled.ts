/**
 * Talent Radar is turned off. Flip to `true` only if we intentionally bring the
 * sourcing product back — until then no cron, UI action, or Claude call should
 * spend on contacts.
 */
export const RADAR_ENABLED = false;

export function isRadarEnabled(): boolean {
  return RADAR_ENABLED;
}

export const RADAR_DISABLED_MESSAGE =
  "Talent Radar is turned off. Flip RADAR_ENABLED in src/lib/radar/enabled.ts to restore it.";
