// Dakikada bir şirket bazlı TTL ve disk anlık görüntüsü alır.

import { appendFile, stat } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';
import { COMPANIES, retentionSecondsFor } from './config.js';

const REFRESH_MS = 60000;
const CSV_FILE = 'retention-observations.csv';
const peakByCompany = new Map(COMPANIES.map((c) => [c.id, 0]));

function formatAge(seconds) {
  if (seconds == null) return '-';
  return `${seconds.toFixed(1)}sn`;
}

async function tick(db, collection) {
  const now = new Date();
  const stats = await collection
    .aggregate([
      { $match: { retentionDemo: true } },
      {
        $group: {
          _id: '$companyId',
          count: { $sum: 1 },
          oldest: { $min: '$ts' },
          newest: { $max: '$ts' },
          expired: { $sum: { $cond: [{ $lte: ['$expireAt', now] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const statsById = new Map(stats.map((s) => [s._id, s]));
  const [{ storageStats: disk }] = await collection.aggregate([
    { $collStats: { storageStats: { scale: 1 } } },
  ]).toArray();
  let fsUsed = '';
  let fsTotal = '';
  try {
    const dbDisk = await db.command({ dbStats: 1, scale: 1 });
    fsUsed = dbDisk.fsUsedSize ?? '';
    fsTotal = dbDisk.fsTotalSize ?? '';
  } catch { /* Yetki yoksa koleksiyon ölçümleri devam eder. */ }
  let ttlDeleted = '';
  try { ttlDeleted = String((await db.admin().serverStatus()).metrics.ttl.deletedDocuments); }
  catch { /* Yetki yoksa diğer ölçümler devam eder. */ }

  console.log(`Retention Monitor — ${now.toISOString()} (her ${REFRESH_MS / 1000}sn yenilenir)`);

  const rows = COMPANIES.map((company) => {
    const s = statsById.get(company.id);
    const count = s ? s.count : 0;
    const prevPeak = peakByCompany.get(company.id);
    const peak = Math.max(prevPeak, count);
    peakByCompany.set(company.id, peak);

    let status;
    if (count === 0) status = 'veri yok';
    else if (count < peak) status = 'SİLME BAŞLADI';
    else status = 'birikiyor';

    const oldestAgeSec = s ? (now.getTime() - s.oldest.getTime()) / 1000 : null;

    return {
      sirket: company.id,
      retentionSaat: retentionSecondsFor(company.id) / 3600,
      kayit: count,
      zirve: peak,
      enEskiYas: formatAge(oldestAgeSec),
      suresiGecmis: s?.expired ?? 0,
      durum: status,
    };
  });

  console.table(rows);
  console.log(`Disk: time-series bucket verisi=${disk.size} B, ayrılan veri=${disk.storageSize} B, ` +
    `yeniden kullanılabilir=${disk.freeStorageSize ?? 0} B, ` +
    `index=${disk.totalIndexSize} B, toplam ayrılan=${disk.totalSize} B`);
  console.log(`Dosya sistemi: kullanılan=${fsUsed || '-'} B, kapasite=${fsTotal || '-'} B`);
  const lines = rows.map((row) => [now.toISOString(), DB_NAME, COLLECTION, row.sirket,
    row.retentionSaat, row.kayit, row.suresiGecmis, row.enEskiYas,
    disk.size, disk.storageSize, disk.freeStorageSize ?? 0,
    disk.totalIndexSize, disk.totalSize, fsUsed, fsTotal, ttlDeleted].join(','));
  await appendFile(CSV_FILE, `${lines.join('\n')}\n`);
}

async function main() {
  try { await stat(CSV_FILE); }
  catch { await appendFile(CSV_FILE, 'time,db,collection,company,retentionHours,count,expired,oldestAge,logicalBytes,storageBytes,reusableBytes,indexBytes,totalBytes,fsUsedBytes,fsTotalBytes,serverTtlDeleted\n'); }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION);

  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(db, collection); }
    catch (err) { console.error('monitor tick hata:', err.message); }
    finally { busy = false; }
  };
  run();
  const timer = setInterval(run, REFRESH_MS);

  process.on('SIGINT', async () => {
    clearInterval(timer);
    await client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('monitor.js hata:', err);
  process.exit(1);
});
