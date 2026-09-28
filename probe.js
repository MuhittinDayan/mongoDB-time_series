// 12 saatlik partial TTL'nin işlediğini geriye tarihli tek kayıtla doğrular.
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';

const WAIT_MS = 60_000;
const DEADLINE_MS = 7 * 60_000;

async function main() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const collection = client.db(DB_NAME).collection(COLLECTION);
    const ttlIndex = (await collection.indexes()).find((i) =>
      i.name === 'ttl_12h' && i.key.ts === 1 && i.expireAfterSeconds === 12 * 3600);
    if (!ttlIndex) throw new Error('12 saatlik partial TTL index yok; önce npm run setup çalıştırın.');

    const now = new Date();
    // 1 saatlik azami bucket aralığını da aşacak kadar eski bir zaman seçilir.
    const ts = new Date(now.getTime() - (13 * 3600 + 5 * 60) * 1000);
    const expireAt = new Date(ts.getTime() + 12 * 3600 * 1000);
    const { insertedId } = await collection.insertOne({
      retentionProbe: true,
      companyId: 1,
      ts,
      expireAt,
    });
    console.log(`Probe yazıldı: ${DB_NAME}.${COLLECTION} _id=${insertedId}`);
    console.log(`12 saat eşiği: ${expireAt.toISOString()}. Bucket TTL silmesi gecikebilir.`);

    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      const stillExists = await collection.findOne(
        { companyId: 1, ts, _id: insertedId }, { projection: { _id: 1 } });
      console.log(`${new Date().toISOString()}: ${stillExists ? 'kayıt hâlâ var' : 'kayıt silindi'}`);
      if (!stillExists) {
        // Kayıt eşiği zaten geçmiş olarak yazıldığından "erken silme" burada ölçülemez.
        console.log('TTL silmesi aynı koleksiyonda doğrulandı.');
        return;
      }
    }
    throw new Error('7 dakika içinde silinmedi; TTL monitor ve index durumunu inceleyin.');
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error('probe.js hata:', err); process.exitCode = 1; });
