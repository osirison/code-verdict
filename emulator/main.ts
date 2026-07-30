/**
 * GitLab emulator HTTP server — for debugging the extension against a live,
 * mutable instance.
 *
 *   npm run emulator -- [--port 8971] [--seed 1] [--scenario happy]
 *
 * Connect the extension with instance URL http://127.0.0.1:<port> and token
 * `glpat-emulator` (or `glpat-expired` / `glpat-readonly` for the auth
 * failure branches). Drive scenarios via the /_emulator control routes —
 * see emulator/README.md.
 */
import * as http from 'node:http';
import { GitLabEmulator } from './engine';
import type { ScenarioName } from './world';
import { SCENARIOS } from './world';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const port = Number(arg('port', '8971'));
const seed = Number(arg('seed', '1'));
const scenario = arg('scenario', 'happy') as ScenarioName;

if (!SCENARIOS.includes(scenario)) {
  console.error(`Unknown scenario "${scenario}". Known: ${SCENARIOS.join(', ')}`);
  process.exit(1);
}

console.log(`GitLab emulator starting (seed ${seed}, scenario ${scenario})…`);

const emulator = new GitLabEmulator({
  seed,
  scenario,
  baseUrl: `http://127.0.0.1:${port}`,
  // The live server anchors the world to the wall clock so ages read
  // realistically while debugging; tests use the fixed default epoch.
  now: new Date().toISOString(),
});

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    const result = emulator.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
    });
    console.log(`${req.method} ${req.url} -> ${result.status}`);
    res.writeHead(result.status, result.headers);
    res.end(JSON.stringify(result.body));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`GitLab emulator listening on http://127.0.0.1:${port}`);
  console.log(`  seed ${seed} · scenario ${scenario} · token glpat-emulator`);
  console.log(`  state: curl http://127.0.0.1:${port}/_emulator/state`);
});
