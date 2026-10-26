import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const publicName = arg('name', '@wafernm/dsh-memory-library');
const version = arg('version', pkg.version);
const out = path.resolve(root, arg('out', 'dist-release'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const item of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
  fs.cpSync(path.join(root, item), path.join(out, item), { recursive: true });
}

const { scripts: _scripts, private: _private, ...rest } = pkg;
const releasePkg = {
  ...rest,
  name: publicName,
  version,
  private: false,
  publishConfig: { access: 'public' },
};
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(releasePkg, null, 2)}\n`);

const patchPath = path.join(out, 'cordis.patch.yml');
fs.writeFileSync(patchPath, fs.readFileSync(patchPath, 'utf8').replaceAll('@local/dsh-memory-library', publicName));

const clientPath = path.join(out, 'client.js');
fs.writeFileSync(clientPath, fs.readFileSync(clientPath, 'utf8').replaceAll('@local/dsh-memory-library', publicName));

console.log(`Release ready: ${out}`);
console.log(`  name:    ${publicName}`);
console.log(`  version: ${version}`);
