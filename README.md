# MongoDB time-series retention deneyi

Veritabanı: `tsdb_retention_test`. Etkin koleksiyon `metrics_ts` gerçek bir MongoDB time-series koleksiyonudur. Eski normal `metrics` koleksiyonu geçiş kontrolü için korunur; yeni kayıtlar yalnızca `metrics_ts` içine yazılır.

## Deney ayarları

| Grup | Şirket sayısı | Ham veri saklama |
| --- | ---: | ---: |
| 12 saat | 25 | 12 saat |
| 24 saat | 25 | 24 saat |
| 36 saat | 25 | 36 saat |
| 48 saat | 25 | 48 saat |

Deney 12 şirketle başladı, sonra 100 şirkete çıkarıldı. Şirketler gruplara sırayla dağıtılır: 1 → 12 saat, 2 → 24 saat, 3 → 36 saat, 4 → 48 saat, 5 → 12 saat, …

`companyId` 1–100 arasında sayıdır ve time-series `metaField` olarak kullanılır. `ts` zaman alanıdır. Her şirket, `config.js` içindeki 1/2/3/4 saniyelik aralıkla rastgele sıcaklık ve nem ölçümü yazar.

Koleksiyonun genel `expireAfterSeconds` değeri 172800 (48 saat) olarak ayarlıdır. `ttl_12h`, `ttl_24h` ve `ttl_36h` partial TTL indeksleri yalnızca ilgili şirket kimliklerine uygulanır. Böylece 12 saatlik kayıt 48 saati beklemez. TTL, `ts` alanından hesaplanır; kayıtta kalan `expireAt` yalnızca eski deneyle karşılaştırma ve gözlem içindir. MongoDB bucket'ı, içindeki tüm kayıtların süresi dolduktan sonra arka planda siler; eşikte anlık silme garantisi yoktur.

30 günlük saklama ve 1/2/12 saatlik özetler bu aşamada etkin değildir. Yalnızca 4 saatlik deney özeti `metrics_rollup_4h` normal koleksiyonunda üretilir; ham veri silindikten sonra özet kalır.

## Kullanım

Bağlantı ayarları (`MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION`) proje klasöründeki `.env` dosyasından `env.js` tarafından okunur. Sistemde aynı adlı bir ortam değişkeni varsa o öncelikli olur; ikisi de yoksa `env.js` içindeki varsayılanlar kullanılır. Ek paket gerekmez; Node'un yerleşik `process.loadEnvFile` fonksiyonu kullanılır. Şirket tablosu ve TTL grupları gibi deney kuralları `config.js` içindedir.

```powershell
npm install
npm run setup
npm run produce
npm run monitor
npm run inspect
npm run rollup:4h
```

`npm run setup`, time-series koleksiyonunu ve TTL indekslerini kurar veya ayarları doğrular; mevcut verileri silmez. `npm run produce` yazıcıyı ön planda çalıştırır. `npm run monitor` dakikada bir şirket bazlı retention ve depolama ölçümlerini `retention-observations.csv` dosyasına ekler. `npm run inspect` koleksiyon türünü, indeksleri ve anlık durumu gösterir. `npm run probe` 12 saatlik partial TTL için geriye tarihli tek bir test kaydı kullanır.

Arka plan yazıcısı zaten çalışıyorsa ayrıca `npm run produce` başlatmayın; ikinci süreç toplam yazma hızını artırır. Retention ve hız ayarlarını değiştirme adımları `TIME_SERIES_MIGRATION_REPORT.md` içindedir.

Etkin arka plan yazıcısını saatte bir `MongoRetentionWriteCheck` zamanlanmış görevi denetler. Son sonuç `write-health-status.json`, geçmiş sonuçlar `write-health.log` dosyasındadır. Yazıcı kapanmışsa görev yeniden başlatır; fark edilmesi bir saate kadar sürebilir. `MongoRetentionRollup4h` görevi de saatlik olarak 4 saatlik özetleri üretir. Son çalışmaları `rollup-4h.log` dosyasındadır. Her iki görev de kullanıcı oturumu açıkken çalışacak biçimde kuruludur.

Compass'ta özetleri `tsdb_retention_test` → `metrics_rollup_4h` altında gör. Örnek filtre: `{ "companyId": 1 }`, sıralama: `{ "windowStart": -1 }`. Geçmişte retention içinde kalan tam pencereleri yeniden taramak için `npm run rollup:4h:backfill` kullan; mevcut özetlere ikinci kayıt eklenmez.

MongoDB Compass: `mongodb://127.0.0.1:27017` → `tsdb_retention_test` → `metrics_ts`. Örnek filtre: `{ "companyId": 42, "retentionDemo": true }`. En yeniler için `ts` azalan sıralama kullanın.

## Şirket bazlı sayfalama

```javascript
const firstPage = await db.collection('metrics_ts')
  .find({ companyId: 42, retentionDemo: true })
  .sort({ ts: -1 })
  .limit(100)
  .toArray();

const nextPage = await db.collection('metrics_ts')
  .find({ companyId: 42, retentionDemo: true, ts: { $lt: firstPage.at(-1).ts } })
  .sort({ ts: -1 })
  .limit(100)
  .toArray();
```

MongoDB otomatik olarak `companyId + ts` bileşik indeksini kurar. Aynı şirkette aynı `ts` değerine sahip ölçümler oluşursa yalnızca `ts` ile sayfalama kayıt atlayabilir; o durumda sayfalama anahtarı ayrıca tasarlanmalıdır.

## Boyut neden küçük görünüyor?

`metrics_ts` ölçümleri aynı şirket ve yakın zaman için sıkıştırılmış bucket'larda saklar. `collStats.size` ve `retention-observations.csv` içindeki eski adıyla `logicalBytes` sütunu, time-series için tek tek ölçümlerin BSON toplamı olarak okunmamalıdır; bucket kayıtlarının boyutunu yansıtır. Diskte ayrılan veri için `storageSize`, indekslerle birlikte toplam için `totalSize` değerine bakın. Eski `metrics` koleksiyonu da geçici olarak diskte durur; veritabanı genelindeki alan onun boyutunu da içerir.

Bu sıkıştırma MongoDB time-series'in kendi özelliğidir: sütun bazlı sıkıştırma ve varsayılan `zstd` otomatik uygulanır. `producer.js` özel bir sıkıştırma yapmaz. `metrics_rollup_4h` içindeki 4 saatlik özetler ise ayrı bir hesaplama sonucudur; time-series sıkıştırmasıyla aynı işlem değildir.

## Geçiş

`migrate-timeseries.js`, yazıcı durdurulduğunda eski `metrics` verilerini yeni `metrics_ts` koleksiyonuna şirket bazında zaman sırasıyla kopyalar. Hedef koleksiyon doluysa çift kayıt oluşmasını önlemek için çalışmayı reddeder. Geçişin uygulama ve doğrulama kaydı için `TIME_SERIES_MIGRATION_REPORT.md` dosyasına bakın.
