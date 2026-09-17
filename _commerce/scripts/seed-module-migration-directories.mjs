// MikroORM's migrator calls fs-extra's ensureDir on the migrations directory of every
// module it migrates, and several Medusa modules ship no such directory at all. A
// prepared release is root-owned and read-only on purpose, so ensureDir fails with
// EACCES and `db:migrate` aborts - after other modules have already been migrated,
// which leaves a half-built schema and no migration evidence.
//
// A module that has no migrations directory means "no migrations to run". An empty
// directory says exactly the same thing to the migrator and makes ensureDir a no-op,
// so the runtime never has to write inside a sealed release. These directories are
// created while the release is still staging, before it is sealed, so the release
// manifest covers them like every other path.
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const argument = process.argv[2] || '';
if (process.argv.length !== 3 || !isAbsolute(argument)) {
  throw new Error('Usage: seed-module-migration-directories.mjs /absolute/release/root');
}
const root = resolve(argument);
if (root !== argument) throw new Error('The release root must not rely on symbolic links or relative segments.');

function realDirectory(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());
}

if (!realDirectory(root)) throw new Error('The release root must be a real directory.');
const modulesDirectory = join(root, '_commerce', 'node_modules', '@medusajs');
if (!realDirectory(modulesDirectory)) throw new Error('The prepared release has no installed @medusajs modules.');

const seeded = [];
const kept = [];
for (const entry of readdirSync(modulesDirectory).sort()) {
  const packageDirectory = join(modulesDirectory, entry);
  if (!realDirectory(packageDirectory)) continue;

  // Never seed next to migrations a package already declares, in either of the two
  // locations Medusa can resolve them from: doing so would hide the real ones with an
  // empty directory and silently stop applying a module's schema changes.
  const declared = join(packageDirectory, 'migrations');
  const compiled = join(packageDirectory, 'dist', 'migrations');
  if (realDirectory(declared) || realDirectory(compiled)) {
    kept.push(entry);
    continue;
  }

  // Medusa appends "migrations" to the module's resolved path: the compiled directory
  // for a built package, the package root otherwise.
  const target = realDirectory(join(packageDirectory, 'dist')) ? compiled : declared;
  mkdirSync(target, { recursive: true, mode: 0o755 });
  seeded.push(target.slice(root.length + 1));
}

console.log(
  `Seeded ${seeded.length} empty module migration directories and left ${kept.length} ` +
  'packages with their own migrations untouched.',
);
