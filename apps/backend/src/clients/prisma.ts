import { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';

/**
 * One client per process.
 *
 * The `globalThis` cache exists for `tsx watch`, which re-evaluates modules on
 * every save: without it a morning of editing leaves a hundred idle pools
 * against Postgres and the next `prisma db push` fails on connection limits.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [{ level: 'warn', emit: 'event' }, { level: 'error', emit: 'event' }],
  });

prisma.$on('warn' as never, (e: { message: string }) => logger.warn({ prisma: e.message }));
prisma.$on('error' as never, (e: { message: string }) => logger.error({ prisma: e.message }));

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}
