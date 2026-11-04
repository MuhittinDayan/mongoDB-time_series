// Project file locations, resolved from this file rather than the working
// directory so that scheduled tasks can start the scripts from any folder.

import { fileURLToPath } from 'node:url';

const fromRoot = (relativePath) => fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

export const ROOT_DIR = fromRoot('');
export const ENV_FILE = fromRoot('.env');
export const PRODUCER_SCRIPT = fromRoot('src/producer.js');

export const OBSERVATIONS_CSV = fromRoot('data/retention-observations.csv');

export const PRODUCER_PID_FILE = fromRoot('logs/producer-live.pid');
export const PRODUCER_RECOVERED_LOG = fromRoot('logs/producer-recovered.log');
export const WRITE_HEALTH_LOG = fromRoot('logs/write-health.log');
export const WRITE_HEALTH_STATUS = fromRoot('logs/write-health-status.json');
