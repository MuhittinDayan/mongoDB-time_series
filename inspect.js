// TTL, şirket bazlı yaş sınırları ve koleksiyon disk ölçülerini raporlar.

import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';
import { COMPANIES, TTL_GRACE_SECONDS, retentionSecondsFor } from './config.js';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION);
  const collectionInfo = await db.listCollections({ name: COLLECTION }).next();

  console.log(`Hedef: ${DB_NAME}.${COLLECTION}`);
  console.log(`Tür: ${collectionInfo?.type ?? 'bulunamadı'}`);
  console.log(`Genel TTL: ${collectionInfo?.options?.expireAfterSeconds ?? '-'} saniye`);
  console.log('=== 1) Index listesi ===');
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const isTtl = Object.prototype.hasOwnProperty.call(idx, 'expireAfterSeconds');
    console.log(
      `  ${idx.name}  key=${JSON.stringify(idx.key)}` +
        (isTtl ? `  <-- partial TTL (expireAfterSeconds=${idx.expireAfterSeconds}, filtre=${JSON.stringify(idx.partialFilterExpression)})` : '')
    );
  }

  console.log('\n=== 2) serverStatus().metrics.ttl ===');
  try {
    const ttl = (await db.admin().serverStatus()).metrics.ttl;
    console.log(`  passes: ${ttl.passes}`);
    console.log(`  deletedDocuments: ${ttl.deletedDocuments} (sunucu geneli)`);
  } catch (err) {
    console.warn(`  TTL sayacı okunamadı: ${err.message}`);
  }

  console.log('\n=== 3) Şirket bazlı yaş kontrolü ===');
  console.log(`  TTL bucket'ları siler; süresi dolan kayıtların ${TTL_GRACE_SECONDS} sn ` +
    'daha görünmesi normaldir. Yalnızca bu payı aşanlar SORUN sayılır.');
  const now = new Date();
  const ageRows = [];
  for (const company of COMPANIES) {
    const oldest = await collection
      .find({ retentionDemo: true, companyId: company.id })
      .sort({ ts: 1 })
      .limit(1)
      .toArray();

    // TTL expireAt'e değil ts'e göre işler; sayımlar da ts üzerinden yapılır.
    const retentionSec = retentionSecondsFor(company.id);
    const expiredBefore = new Date(now.getTime() - retentionSec * 1000);
    const overdueBefore = new Date(expiredBefore.getTime() - TTL_GRACE_SECONDS * 1000);
    const expired = await collection.countDocuments({
      retentionDemo: true, companyId: company.id, ts: { $lte: expiredBefore },
    });
    const overdue = expired === 0 ? 0 : await collection.countDocuments({
      retentionDemo: true, companyId: company.id, ts: { $lte: overdueBefore },
    });
    if (oldest.length === 0) {
      ageRows.push({
        sirket: company.id,
        retentionSn: retentionSec,
        suresiGecmis: expired,
        gecikmis: overdue,
        enEskiYasSn: '-',
        sinirAsimi: '-',
        durum: 'veri yok',
      });
      continue;
    }

    const ageSec = (now.getTime() - oldest[0].ts.getTime()) / 1000;
    ageRows.push({
      sirket: company.id,
      retentionSn: retentionSec,
      suresiGecmis: expired,
      gecikmis: overdue,
      enEskiYasSn: ageSec.toFixed(1),
      sinirAsimi: expired > 0 ? `+${(ageSec - retentionSec).toFixed(1)}sn` : 'hayır',
      durum: overdue > 0 ? 'SORUN' : expired > 0 ? 'OK (bucket bekliyor)' : 'OK',
    });
  }
  console.table(ageRows);

  console.log('=== 4) Disk ölçüleri (koleksiyonun tamamı) ===');
  const [{ storageStats: disk }] = await collection.aggregate([
    { $collStats: { storageStats: { scale: 1 } } },
  ]).toArray();
  console.table([{
    // Time-series'te storageStats.count ölçüm sayısı değildir; bucket sayısı gösterilir.
    bucketSayisi: disk.timeseries?.bucketCount ?? disk.count,
    timeSeriesBucketBayt: disk.size,
    ayrilanVeriBayt: disk.storageSize,
    yenidenKullanilabilirBayt: disk.freeStorageSize ?? 0,
    indexBayt: disk.totalIndexSize,
    toplamAyrilanBayt: disk.totalSize,
  }]);
  try {
    const dbDisk = await db.command({ dbStats: 1, scale: 1 });
    console.log(`MongoDB veri disk bölümü: kullanılan=${dbDisk.fsUsedSize ?? '-'} B, ` +
      `kapasite=${dbDisk.fsTotalSize ?? '-'} B (tüm dosya sistemi)`);
  } catch (err) {
    console.warn(`Dosya sistemi ölçüsü okunamadı: ${err.message}`);
  }

  console.log("=== 5) Örnek sorgu için explain('executionStats') ===");
  const sampleCompany = COMPANIES[0].id;
  const explainResult = await collection
    .find({ retentionDemo: true, companyId: sampleCompany })
    .sort({ ts: -1 })
    .explain('executionStats');

  // Time-series find, bucket açma aşamasıyla yeniden yazılır; plan üst düzeyde
  // (classic/SBE: winningPlan.queryPlan) ya da stages[].$cursor içinde gelebilir.
  function findKey(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const [k, value] of Object.entries(node)) {
      if (k === 'rejectedPlans') continue;
      const found = findKey(value, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  function collectStageNames(node, acc = []) {
    if (Array.isArray(node)) node.forEach((n) => collectStageNames(n, acc));
    else if (node && typeof node === 'object') {
      if (typeof node.stage === 'string') acc.push(node.stage);
      for (const value of Object.values(node)) collectStageNames(value, acc);
    }
    return acc;
  }

  const winningPlan = findKey(explainResult, 'winningPlan');
  const execStats = findKey(explainResult, 'executionStats') ?? {};
  const stages = collectStageNames(winningPlan);
  const usesIxscan = stages.includes('IXSCAN');
  const usesCollscan = stages.includes('COLLSCAN');

  console.log(`  Sorgu: find({ retentionDemo: true, companyId: ${sampleCompany} }).sort({ ts: -1 })`);
  console.log(`  Plan aşamaları: ${stages.join(' -> ')}`);
  console.log(`  Tarama tipi: ${usesIxscan ? 'IXSCAN (index kullanıldı)' : usesCollscan ? 'COLLSCAN (index kullanılmadı!)' : 'bilinmiyor'}`);
  console.log(`  nReturned: ${execStats.nReturned}`);
  console.log(`  totalDocsExamined: ${execStats.totalDocsExamined} (time-series'te bucket sayısı)`);
  console.log(`  totalKeysExamined: ${execStats.totalKeysExamined}`);

  await client.close();
}

main().catch((err) => {
  console.error('inspect.js hata:', err);
  process.exit(1);
});
