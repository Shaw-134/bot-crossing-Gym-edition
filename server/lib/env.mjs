/**
 * Loads an optional `.env` from the repository root into `process.env`, before anything else
 * in the server reads it. The file is gitignored; `.env.example` lists what is understood.
 * Variables already set in the shell win, and a missing file is not an error.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
try {
  process.loadEnvFile(file)
} catch (err) {
  if (err?.code !== 'ENOENT') console.warn(`[env] could not read ${file}: ${err.message}`)
}
