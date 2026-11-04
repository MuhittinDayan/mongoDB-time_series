// Connection settings: loads and reads the .env file in the project root.
// Experiment rules (company table, TTL groups) live in config.js.

import { ENV_FILE } from './paths.js';

// A missing file is not an error, because the values may come from real
// environment variables. There are no built-in defaults.
try {
  process.loadEnvFile(ENV_FILE);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

export const MONGO_URI = process.env.MONGO_URI;
export const DB_NAME = process.env.MONGO_DB;
export const COLLECTION = process.env.MONGO_COLLECTION;

if (!/^mongodb(\+srv)?:\/\//.test(MONGO_URI)) {
  throw new Error('Invalid MONGO_URI: it must start with mongodb:// or mongodb+srv://');
}
