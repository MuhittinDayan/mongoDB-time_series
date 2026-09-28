// Bağlantı ayarları: proje klasöründeki .env dosyasını yükler ve okur.
// Deney kuralları (şirket tablosu, TTL grupları) config.js içindedir.

import { fileURLToPath } from 'node:url';

// Yol bu dosyaya göre çözülür; zamanlanmış görevler başka klasörden başlasa da
// .env bulunur. Dosya yoksa ortam değişkenleri ve aşağıdaki varsayılanlar kullanılır.
try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

export const MONGO_URI = process.env.MONGO_URI;
export const DB_NAME = process.env.MONGO_DB;
export const COLLECTION = process.env.MONGO_COLLECTION;

if (!/^mongodb(\+srv)?:\/\//.test(MONGO_URI)) {
  throw new Error(`MONGO_URI geçersiz: mongodb:// veya mongodb+srv:// ile başlamalı`);
}
