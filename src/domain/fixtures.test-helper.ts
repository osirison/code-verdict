import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The reference payloads the spec ships — the source of truth for tests. */
export function loadSpecFixtures(): Record<string, unknown> {
  const path = join(process.cwd(), 'spec', 'specs', 'Code Verdict - API fixtures.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
