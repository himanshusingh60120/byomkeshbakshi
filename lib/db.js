// lib/db.js
import { neon } from '@neondatabase/serverless';

let cached = null;

/**
 * Created on first request, not at import time — otherwise `next build`
 * fails whenever DATABASE_URL isn't present in the build environment.
 */
export function getSql() {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = neon(url);
  }
  return cached;
}
