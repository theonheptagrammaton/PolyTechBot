#!/usr/bin/env tsx
/**
 * One-off migration: enable copySells on all existing subscriptions that have it disabled.
 * Run with: npx tsx scripts/enableCopySells.ts
 */

import { prisma } from '../src/database/prisma';

async function main() {
  const result = await prisma.copySubscription.updateMany({
    where: { copySells: false },
    data: { copySells: true },
  });

  console.log(`Updated ${result.count} subscription(s) — copySells set to true.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
