// Deney kuralları: şirket tablosu, saklama grupları ve zaman yardımcıları.
// Bağlantı ayarları (.env) env.js içindedir.

// Deneysel time-series saklama süreleri. TTL, ts + şirketin süresiyle işler.
// Deney 12 şirketle başladı, sonra 100 şirkete çıkarıldı.
const COMPANY_COUNT = 100;
const RETENTION_HOURS = [12, 24, 36, 48];

// Şirketler saklama gruplarına sırayla dağıtılır: 1→12s, 2→24s, 3→36s, 4→48s,
// 5→12s ... Her grup 25 şirket; grup içindeki sıraya göre aralık 1-4 sn döner.
export const COMPANIES = Array.from({ length: COMPANY_COUNT }, (_, i) => ({
  id: i + 1,
  retentionHours: RETENTION_HOURS[i % RETENTION_HOURS.length],
  intervalSec: (Math.floor(i / RETENTION_HOURS.length) % 4) + 1,
}));

// TTL kuralları şirket tablosundan türetilir: en uzun süre koleksiyonun genel
// TTL'si, daha kısa süreler ise partial TTL indeksleri olur.
export const RETENTION_GROUPS = [...new Set(COMPANIES.map((c) => c.retentionHours))]
  .sort((a, b) => a - b);
export const MAX_RETENTION_HOURS = RETENTION_GROUPS.at(-1);
export const PARTIAL_TTL_HOURS = RETENTION_GROUPS.filter((h) => h !== MAX_RETENTION_HOURS);

// Time-series TTL bucket'ı, içindeki tüm ölçümlerin süresi dolunca siler. seconds
// granularity ile bucket en çok 1 saat kapsar; TTL taraması da ~60 sn'de bir çalışır.
export const TTL_GRACE_SECONDS = 3600 + 5 * 60;

export function companyIdsFor(retentionHours) {
  return COMPANIES.filter((c) => c.retentionHours === retentionHours).map((c) => c.id);
}

export function getCompany(companyId) {
  const company = COMPANIES.find((c) => c.id === companyId);
  if (!company) {
    throw new Error(`Bilinmeyen companyId: ${companyId}`);
  }
  return company;
}

export function retentionSecondsFor(companyId) {
  return getCompany(companyId).retentionHours * 3600;
}

export function expireAtFor(companyId, now = new Date()) {
  return new Date(now.getTime() + retentionSecondsFor(companyId) * 1000);
}
