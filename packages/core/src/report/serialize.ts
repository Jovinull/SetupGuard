import type { Report } from '../model/types.js';

/**
 * Serialise a report as JSON.
 *
 * This is the machine-readable contract consumed by CI and by future
 * integrations, so it is produced from the report as-is: no interface-specific
 * fields, no reordering. `schemaVersion` is the compatibility signal.
 */
export function reportToJson(report: Report, indent = 2): string {
  return JSON.stringify(report, null, indent);
}
