import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/clients/prisma.js';

/**
 * The SQL Prisma cannot express.
 *
 * `prisma db push` owns the schema; this owns the things a schema language has
 * no syntax for — partial indexes, expression indexes, and the trigram index
 * the screener's symbol search needs. They are applied AFTER a push, are all
 * `IF NOT EXISTS`, and are therefore safe to re-run on every deploy.
 */
const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const dir = join(here, '..', 'prisma', 'sql');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // Split on blank-line-separated statements: `$executeRawUnsafe` takes one
    // statement at a time, and `CREATE INDEX CONCURRENTLY` cannot run inside a
    // transaction, which a multi-statement call would open.
    const statements = sql
      .split(/;\s*\n/)
      // COMMENTS ARE STRIPPED, NOT USED TO DISCARD THE STATEMENT. Every
      // statement in these files is preceded by the paragraph explaining why it
      // exists, so a filter that dropped anything starting with `--` would drop
      // all of them — which is exactly what it did, silently, until the first
      // index that depended on an extension failed to find it.
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim()
      )
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
    console.log(`applied ${file} (${statements.length} statements)`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
