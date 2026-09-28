// Her şirket için bağımsız bir setInterval açar. time-series TTL, ts ve
// companyId metadata'sına göre işler; expireAt gözlem amaçlı tutulur.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';
import { COMPANIES, expireAtFor } from './config.js';

// healthcheck.js bu dosyadaki PID'e bakarak yazıcının çalışıp çalışmadığını anlar.
const PID_FILE = new URL('./producer-live.pid', import.meta.url);

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log(`Yazma hedefi: ${DB_NAME}.${COLLECTION}`);
  await writeFile(PID_FILE, String(process.pid));

  const collection = client.db(DB_NAME).collection(COLLECTION);
  const timers = [];
  let totalCount = 0;
  let skippedCount = 0;

  console.log('\nÜretim başlıyor. Durdurmak için Ctrl+C.\n');

  for (const company of COMPANIES) {
    // Önceki yazma bitmeden yenisi başlamaz; MongoDB yavaşlarsa istekler birikmez.
    let inFlight = false;
    const write = async () => {
      if (inFlight) {
        skippedCount += 1;
        return;
      }
      inFlight = true;
      const now = new Date();
      const expireAt = expireAtFor(company.id, now);
      const doc = {
        retentionDemo: true,
        companyId: company.id,
        ts: now,
        expireAt,
        temperature: +(18 + Math.random() * 10).toFixed(2),
        humidity: +(30 + Math.random() * 40).toFixed(2),
      };

      try {
        await collection.insertOne(doc);
        totalCount += 1;
        if (totalCount % 100 === 0) {
          console.log(`[${now.toISOString()}] Toplam yazılan: ${totalCount}, atlanan: ${skippedCount}`);
        }
      } catch (err) {
        console.error(`[${company.id}] yazma hatası:`, err.message);
      } finally {
        inFlight = false;
      }
    };

    write();
    timers.push(setInterval(write, company.intervalSec * 1000));
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} alındı, timer'lar temizleniyor...`);
    for (const t of timers) clearInterval(t);
    await client.close();
    try {
      // Başka bir yazıcı dosyayı devraldıysa ona dokunma.
      if ((await readFile(PID_FILE, 'utf8')).trim() === String(process.pid)) await rm(PID_FILE);
    } catch { /* PID dosyası zaten yok. */ }
    console.log('Bağlantı kapatıldı. Toplam yazılan döküman:', totalCount);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('producer.js hata:', err);
  process.exit(1);
});
