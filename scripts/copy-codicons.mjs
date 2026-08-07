/**
 * Codicons ship with the extension, not from a CDN — a webview's CSP blocks
 * remote fonts, and the marketplace build must be self-contained. The files
 * are copied out of node_modules at build time rather than vendored into git,
 * so bumping the dependency is the only update step.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@vscode', 'codicons', 'dist');
const to = join(root, 'media', 'codicons');

await mkdir(to, { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  await copyFile(join(from, file), join(to, file));
}
