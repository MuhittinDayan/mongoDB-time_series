# Time-series geçiş ve retention raporu

Tarih: 27 Eylül 2026 (Europe/Istanbul). Veritabanı: `tsdb_retention_test`. MongoDB sürümü: 8.0.32.

## Sonuç

Eski `metrics` normal koleksiyonundan yeni `metrics_ts` time-series koleksiyonuna **4.166.281 deney kaydı** aktarıldı. Eski koleksiyon silinmedi. Yazıcı yeni koleksiyona yönlendirildi. Otomatik sağlık kontrolü önce 5 dakikada bir çalışıyordu; 27 Eylül 2026 tarihinde aralığı **1 saate** çıkarıldı. Son manuel sağlık kontrolü 2026-09-27 14:42:26 UTC tarihinde `OK` verdi; son yazı yaşı 0 saniyeydi.

## Geçiş sırası

1. `MongoRetentionWriteCheck` görevi devre dışı bırakıldı ve eski `producer.js` süreci durduruldu.
2. `metrics_ts`, `timeField: ts`, `metaField: companyId`, `granularity: seconds` ve genel `expireAfterSeconds: 172800` ile oluşturuldu.
3. 12, 24 ve 36 saatlik partial TTL indeksleri kuruldu.
4. 100 şirketin mevcut kayıtları, her şirket için `ts` artan sırada 2.000'lik partilerle kopyalandı. Aktarım 14:39:28–14:40:23 UTC arasında tamamlandı.
5. Koleksiyon türü, TTL indeksleri, en yeni kaydın zamanı ve farklı gruplardan sekiz örnek kaydın kimliği/ölçüm değerleri karşılaştırıldı; sekiz eşleşme de başarılıydı.
6. Yazıcı yeni koleksiyona başlatıldı; yeni ölçümler görüldü. Zamanlanmış görev tekrar etkinleştirildi. Yazıcının durdurulmasıyla yeniden başlaması arasında yaklaşık 4 dakikalık ölçüm boşluğu oluştu; bu sürede deneysel sentetik veri üretilmedi.

## TTL nasıl uygulanıyor?

| Şirket grubu | Etkin kural | `ts` üzerine eklenen süre |
| --- | --- | ---: |
| 12 saat | `ttl_12h` partial TTL | 43.200 saniye |
| 24 saat | `ttl_24h` partial TTL | 86.400 saniye |
| 36 saat | `ttl_36h` partial TTL | 129.600 saniye |
| 48 saat | Koleksiyonun genel TTL kuralı | 172.800 saniye |

Üç partial indeksin anahtarı `{ ts: 1 }` ve filtresi ilgili `companyId` değerleridir. 48 saatlik genel kural ve kısa süreli partial indeksler aynı anda bulunur. Kısa gruplar 48 saati beklemez. Eski kayıtlardan taşınan `expireAt` alanı yeni koleksiyonda silmeyi yönetmez; `ts` ve şirket grubu yönetir.

MongoDB time-series TTL, süresi dolmuş belgeleri tek tek aynı saniyede kaldırmaz. Aynı şirketin yaklaşık zamanlı belgeleri bucket'larda tutulur; bucket'taki tüm kayıtların süresi dolduğunda arka plan TTL işlemi bucket'ı siler. `seconds` granularity ile bucket zaman aralığı en çok bir saattir; TTL taraması yaklaşık 60 saniyede bir çalışır. Yük altında ek gecikme olabilir. Bu nedenle retention sınırını geçen az sayıda kayıt kısa süre daha görülebilir.

## Doğrulama sınırı ve sonraki aşama

Geçişte koleksiyon türü, ayarlar, indeksler ve yazma akışı doğrulandı. **12 saatlik partial TTL, tek kayıtlı kontrollü testte doğrulandı.** `npm run probe` ile `companyId: 1` için 13 saat 5 dakika öncesine tarihli bir kayıt yazıldı; MongoDB kaydı 2026-09-27 14:45:16 UTC tarihinde sildi. 24/36/48 saatlik doğal silinme döngüsü henüz zaman içinde gözlenmedi. Uzun dönem gözlemler için `npm run monitor` kullanılabilir; sonuçlar `retention-observations.csv` dosyasında tutulur.

Eski `metrics` koleksiyonunun kendi `expireAt` TTL indeksi hâlâ aktiftir. Oradaki kayıtlar da eski süreleri doldukça silinecektir; geçiş doğrulaması için koleksiyon şimdilik korunmuştur. Aktarım sürerken iki koleksiyonun birlikte yer kaplaması geçicidir.

30 günlük retention ve 1/2/12 saatlik özetler etkin değildir. **4 saatlik özetleme** deney için ayrı bir koleksiyonda etkinleştirildi; ayrıntıları aşağıdadır.

## Saatlik canlılık kontrolü

`MongoRetentionWriteCheck` görevinin tekrar aralığı `PT5M` değerinden `PT1H` değerine değiştirildi; görev komutu yine `healthcheck.cmd` ve `healthcheck.js` dosyalarıdır. Bir kontrolde son kayıt 120 saniyeden eskiyse ve üretici süreci yoksa yeniden başlatılır. Kontroller artık saatte bir yapıldığı için durmuş yazıcının fark edilmesi bir saate kadar gecikebilir. Görevin Windows XML çıktısında `PT1H` doğrulandı. Görev, kullanıcı oturumu açıkken çalışacak şekilde ayarlıdır.

## Deneysel 4 saatlik özetleme

Kaynak `metrics_ts`, hedef **normal** MongoDB koleksiyonu `metrics_rollup_4h`'dir. Her özet bir `companyId` ile UTC'ye göre hizalanmış `[windowStart, windowEnd)` 4 saatlik aralığı temsil eder. Şu alanlar yazılır: `count`, sıcaklık/nem için `min`, `max`, `avg`, ilk/son ölçüm zamanı, kaynak koleksiyon ve oluşturma zamanı. Birleşik benzersiz indeks `{ companyId: 1, windowStart: 1 }` aynı pencerenin ikinci kez eklenmesini önler. Özet koleksiyonuna TTL konulmadı; ham kayıt silindikten sonra özet kalır.

`rollup-4h.js` yalnızca **tamamlanmış** pencereleri işler. Düzenli çalışma son iki tamamlanmış pencereyi tarar, mevcut özeti değiştirmeden eksik olanı ekler. İlk kurulumda `node rollup-4h.js --backfill` çalıştırıldı; her şirket için retention sınırının tamamen içinde kalan tam pencereler seçildi. Bu, eski bir pencerenin TTL nedeniyle kısmen silinmiş ham verisinden eksik özet üretmeyi önler. Geç gelen ölçümler bu deneysel üreticide bulunmadığından tamamlanmış bir pencerenin özeti sonradan değiştirilmez.

İlk çalıştırma **525 özet** oluşturdu. Aynı backfill tekrarlandığında **0 yeni özet** oluştu. Şirket 1'in 2026-09-27 08:00–12:00 UTC penceresinde özet `count: 14193`, sıcaklık ortalaması `22.967209187627702`, nem ortalaması `50.01565842316635` verdi; aynı pencerenin ham veri sorgusuyla birebir eşleşti.

`MongoRetentionRollup4h` Windows görevi işi **saatte bir** `rollup-4h.cmd` üzerinden çalıştırır. Görev manuel tetiklenerek sınandı: son sonuç `0`, log durumu `OK`, tekrar eklenen kayıt `0`. Çıktı `rollup-4h.log` dosyasına yazılır. Bu görev de kullanıcı oturumu açıkken ve cihaz pilde değilken çalışacak biçimde kayıtlıdır. Uzun kesintiden sonra, retention içinde hâlâ tam olarak elde bulunan eski pencereleri doldurmak için `npm run rollup:4h:backfill` kullanılabilir; silinmiş ham veri geri getirilemez.

Compass'ta `tsdb_retention_test.metrics_rollup_4h` açılıp `{ "companyId": 1 }` filtresi ve `{ "windowStart": -1 }` sıralamasıyla özetler görülebilir. 4 saatlik pencereler UTC'de 00:00, 04:00, 08:00, 12:00, 16:00 ve 20:00'de başlar.

## Hangi dosya ne yapıyor?

| Dosya | Görev ve değiştirilecek ayar |
| --- | --- |
| `env.js` / `.env` | MongoDB adresi, veritabanı ve koleksiyon adı. `.env` dosyasından okunur, adres biçimi doğrulanır. |
| `config.js` | 100 şirketin `retentionHours` ve `intervalSec` değerleri (deney 12 şirketle başladı, sonra 100'e çıkarıldı; şirketler 12/24/36/48 saatlik gruplara sırayla dağıtılır). Saklama grupları ve TTL sürelerinin türetildiği yer. |
| `setup.js` / `retention.js` | Time-series koleksiyonunu doğrular; `config.js`'ten türetilen genel TTL (en uzun süre) ile kısa süreli partial TTL indekslerini kurar. Uyuşmazlıkta hangi `collMod`/`dropIndex` komutunun gerektiğini yazar. |
| `producer.js` | `config.js` içindeki aralıklarda sentetik sıcaklık/nem kaydı yazar. `expireAt` gözlem içindir; time-series TTL tarafından kullanılmaz. |
| `healthcheck.js` | Şirket 1'in en son yazısına bakar, 120 saniyeden eskiyse durmuş üreticiyi yeniden başlatır. |
| `monitor.js` / `inspect.js` | Şirket bazlı saklama, disk ve indeks durumunu gösterir. |
| `probe.js` | 12 saatlik partial TTL silmesini geriye tarihli tek bir kayıtla sınar. |
| `migrate-timeseries.js` | Eski `metrics` verilerini **yalnızca boş** `metrics_ts` koleksiyonuna taşımak için tek seferlik araçtır. Dolu hedefte tekrar çalışmaz. |
| `rollup-4h.js` | Tamamlanmış 4 saatlik pencereleri özetler; `--backfill` güvenli geçmiş pencereleri doldurur. |
| `rollup-4h.cmd` / `rollup-4h.log` | Saatlik Windows görevinin komutu ve çalışma çıktısı. |

## Ayarlar nasıl değiştirilir?

**Yalnızca yazma aralığı değişecekse:** `config.js` içindeki ilgili şirketin `intervalSec` değerini değiştirip çalışan `producer.js` sürecini yeniden başlatmak yeterlidir. MongoDB indeksleri değişmez. Mevcut arka plan yazıcısı çalışırken ikinci bir `npm run produce` başlatmak yazma hızını ikiye katlar.

**Retention grubu veya şirket kimliği değişecekse:** yalnızca `config.js` içindeki şirket tablosunu düzenle. En uzun süre koleksiyonun genel TTL'si, diğer süreler partial TTL indeksleri olarak tablodan otomatik türetilir. MongoDB'deki mevcut ayarlar dosya düzenlemesiyle kendiliğinden değişmez; `npm run setup` uyuşmazlığı görürse gereken komutu yazarak durur:

1. Üreticiyi ve `MongoRetentionWriteCheck` zamanlanmış görevini geçici olarak durdur. Böylece geçiş sırasında iki farklı kurala göre yazma olmaz.
2. Genel TTL süresi değişiyorsa `mongosh` içinde ilgili saniye değeriyle `db.runCommand({ collMod: 'metrics_ts', expireAfterSeconds: 172800 })` çalıştır. Örnekteki `172800` mevcut 48 saattir; 30 gün için `2592000` olur.
3. İçeriği değişen eski partial TTL indekslerini, örneğin `db.metrics_ts.dropIndex('ttl_12h')`, kaldır. Sonra proje klasöründe `npm run setup` çalıştır; bu komut güncel `config.js` / `setup.js` listesine göre indeksleri yeniden kurar. Genel TTL `collMod` ile güncellenmeden `setup` çalıştırılırsa ayar uyuşmazlığında hata verir.
4. `db.getCollectionInfos({ name: 'metrics_ts' })` ve `db.metrics_ts.getIndexes()` ile koleksiyon TTL'sini, grup filtrelerini ve saniye değerlerini kontrol et. Yazıcıyı yeniden başlatıp zamanlanmış görevi etkinleştir; `node healthcheck.js` ile son yazının güncel olduğunu doğrula.

Süreyi kısaltmak eski ölçümleri hemen silinmeye uygun hâle getirebilir. Bir şirketin retention grubunu değiştirmek, aynı `companyId` altındaki mevcut ölçümlere de yeni kuralı uygular; daha önce silinmiş kayıtlar geri gelmez. `monitor.js` içindeki süresi geçmiş sayacı `expireAt` üzerinden hesaplandığı için şirket tablosu ve yazıcı birlikte güncellenmelidir; önceden yazılmış kayıtlardaki `expireAt` geçmişteki politikayı yansıtmaya devam eder.

30 günlük gerçek deney için 15–20 proje, 10 saniyelik akış ve özetleme politikasının ayrıca modellenmesi gerekir. Bu deneyin 100 şirketlik üreticisi ve partial indeksleri doğrudan o hedef düzen olarak kabul edilmemelidir.

## Boyut ölçümlerinin yorumu

27 Eylül 2026 20:37 Türkiye saati civarında `metrics_ts` yaklaşık **4,5 milyon ölçüm** içeriyordu. Örnek ölçümün tek başına BSON boyutu 122 bayttı; aynı ölçümler ayrı belgeler olarak tutulsa yaklaşık 524 MiB ederdi. Time-series koleksiyonunun `collStats.size` değeri yaklaşık 35,7 MiB, `storageSize` değeri yaklaşık 27,3 MiB ve indeksleri yaklaşık 0,5 MiB idi. Bu fark şirket/zaman bucket'ları, sütun sıkıştırması ve küçük, birbirine benzeyen sentetik ölçümlerden kaynaklanır. Bu oran gerçek üretim belgeleri için varsayılmamalıdır.

**Sıkıştırma MongoDB time-series'in yerleşik özelliğidir.** Koleksiyon ölçümleri bucket'larda saklar; MongoDB sütun bazlı sıkıştırma ve varsayılan olarak `zstd` uygular. Projedeki `producer.js` ayrıca bir sıkıştırma algoritması çalıştırmaz. Deneysel 4 saatlik özetleme de bu sıkıştırmadan ayrıdır: `rollup-4h.js` hesaplanmış istatistikleri normal `metrics_rollup_4h` koleksiyonuna yazar. Sıkıştırma tekil ölçümlere erişimi korurken özet kayıtlar çok sayıda ölçümü tek bir istatistik belgesinde temsil eder.

Eski `metrics` normal koleksiyonu hâlâ diskte yer kaplar. Aynı anda onun `storageSize` değeri yaklaşık 148 MiB, indeksleri yaklaşık 216 MiB idi. `metrics_rollup_4h` koleksiyonundaki birkaç yüz özetin boyutu çok daha küçüktür. `monitor.js` CSV dosyasındaki `logicalBytes` sütununun adı eski normal koleksiyondan kalmadır; `metrics_ts` satırlarında tek tek ölçümlerin toplam BSON boyutu olarak yorumlanmamalıdır.

## Kaynaklar

- MongoDB partial TTL: https://www.mongodb.com/docs/v8.0/core/index-ttl/
- MongoDB time-series otomatik silme: https://www.mongodb.com/docs/v8.0/core/timeseries/timeseries-automatic-removal/
- MongoDB time-series veri taşıma: https://www.mongodb.com/docs/v8.0/core/timeseries/timeseries-migrate-with-aggregation/
- MongoDB time-series sıkıştırma: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-compression/
