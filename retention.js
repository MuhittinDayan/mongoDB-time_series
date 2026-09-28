// Time-series koleksiyonunu ve partial TTL indekslerini config.js'e göre kurar
// veya doğrular. Uyuşmazlıkta sessizce devam etmez, ne yapılacağını söyler.
import {
  MAX_RETENTION_HOURS,
  PARTIAL_TTL_HOURS,
  companyIdsFor,
} from './config.js';

const HOUR = 3600;

export async function ensureTimeSeriesCollection(db, name) {
  const expireAfterSeconds = MAX_RETENTION_HOURS * HOUR;
  const existing = await db.listCollections({ name }).next();
  if (!existing) {
    await db.createCollection(name, {
      timeseries: { timeField: 'ts', metaField: 'companyId', granularity: 'seconds' },
      expireAfterSeconds,
    });
    return;
  }
  if (existing.type !== 'timeseries' ||
    existing.options.timeseries?.timeField !== 'ts' ||
    existing.options.timeseries?.metaField !== 'companyId') {
    throw new Error(`${db.databaseName}.${name} beklenen time-series koleksiyonu değil ` +
      '(timeField: ts, metaField: companyId)');
  }
  if (existing.options.expireAfterSeconds !== expireAfterSeconds) {
    throw new Error(`${name} genel TTL ${existing.options.expireAfterSeconds} sn, config.js ` +
      `${expireAfterSeconds} sn (${MAX_RETENTION_HOURS} saat) bekliyor. mongosh: ` +
      `db.runCommand({ collMod: '${name}', expireAfterSeconds: ${expireAfterSeconds} })`);
  }
}

function sameIds(a = [], b = []) {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export async function ensureRetentionIndexes(collection) {
  const indexes = await collection.indexes();
  const wanted = new Set(PARTIAL_TTL_HOURS.map((h) => `ttl_${h}h`));
  const problems = [];

  const stale = indexes.filter((i) => /^ttl_\d+h$/.test(i.name) && !wanted.has(i.name));
  for (const idx of stale) {
    problems.push(`${idx.name} artık config.js'te yok; kaldırın: ` +
      `db.${collection.collectionName}.dropIndex('${idx.name}')`);
  }

  const toCreate = [];
  for (const hours of PARTIAL_TTL_HOURS) {
    const name = `ttl_${hours}h`;
    const ids = companyIdsFor(hours);
    const current = indexes.find((i) => i.name === name);
    if (!current) {
      toCreate.push({ name, hours, ids });
      continue;
    }
    const ok = JSON.stringify(current.key) === JSON.stringify({ ts: 1 }) &&
      current.expireAfterSeconds === hours * HOUR &&
      sameIds(current.partialFilterExpression?.companyId?.$in, ids);
    if (!ok) {
      problems.push(`${name} ayarları config.js ile uyuşmuyor; kaldırıp setup'ı yeniden ` +
        `çalıştırın: db.${collection.collectionName}.dropIndex('${name}')`);
    }
  }

  if (problems.length) {
    throw new Error(`TTL indeksleri güncel değil:\n  - ${problems.join('\n  - ')}`);
  }

  for (const { name, hours, ids } of toCreate) {
    await collection.createIndex({ ts: 1 }, {
      name,
      partialFilterExpression: { companyId: { $in: ids } },
      expireAfterSeconds: hours * HOUR,
    });
  }
  return toCreate.map((i) => i.name);
}
