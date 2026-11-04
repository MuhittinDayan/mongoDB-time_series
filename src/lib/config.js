// Experiment rules: company table, retention groups and time helpers.
// Connection settings (.env) live in env.js.

// Experimental time-series retention periods. TTL is applied as ts + the company's period.
// The experiment started with 12 companies and was later expanded to 100.
const COMPANY_COUNT = 100;
const RETENTION_HOURS = [12, 24, 36, 48];

// Companies are assigned to retention groups in turn: 1→12h, 2→24h, 3→36h, 4→48h,
// 5→12h ... Each group has 25 companies; the 1-4 s interval rotates by position in the group.
export const COMPANIES = Array.from({ length: COMPANY_COUNT }, (_, i) => ({
  id: i + 1,
  retentionHours: RETENTION_HOURS[i % RETENTION_HOURS.length],
  intervalSec: (Math.floor(i / RETENTION_HOURS.length) % 4) + 1,
}));

// TTL rules are derived from the company table: the longest period becomes the
// collection's general TTL, and the shorter periods become partial TTL indexes.
export const RETENTION_GROUPS = [...new Set(COMPANIES.map((c) => c.retentionHours))]
  .sort((a, b) => a - b);
export const MAX_RETENTION_HOURS = RETENTION_GROUPS.at(-1);
export const PARTIAL_TTL_HOURS = RETENTION_GROUPS.filter((h) => h !== MAX_RETENTION_HOURS);

// Time-series TTL deletes a bucket once all of its measurements have expired. With seconds
// granularity a bucket spans at most 1 hour, and the TTL pass runs about every 60 s.
export const TTL_GRACE_SECONDS = 3600 + 5 * 60;

export function companyIdsFor(retentionHours) {
  return COMPANIES.filter((c) => c.retentionHours === retentionHours).map((c) => c.id);
}

export function getCompany(companyId) {
  const company = COMPANIES.find((c) => c.id === companyId);
  if (!company) {
    throw new Error(`Unknown companyId: ${companyId}`);
  }
  return company;
}

export function retentionSecondsFor(companyId) {
  return getCompany(companyId).retentionHours * 3600;
}

export function expireAtFor(companyId, now = new Date()) {
  return new Date(now.getTime() + retentionSecondsFor(companyId) * 1000);
}
