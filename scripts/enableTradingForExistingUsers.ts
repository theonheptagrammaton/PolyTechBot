#!/usr/bin/env tsx
/**
 * Enable trading for all existing users
 * This script enables CTF trading approval for users who don't have it enabled yet
 */

import { prisma } from '../src/database/prisma';
import { enableTrading } from '../src/services/deposit';
import { logger } from '../src/utils/logger';

async function main() {
  try {
    console.log('🔍 Finding users who need trading enabled...\n');

    // Get all users who don't have trading enabled
    const users = await prisma.user.findMany({
      where: {
        tradingEnabled: false,
        isActive: true,
      },
      select: {
        id: true,
        telegramId: true,
        username: true,
        walletAddress: true,
        encryptedPrivateKey: true,
        tradingEnabled: true,
      },
    });

    console.log(`Found ${users.length} users who need trading enabled\n`);

    if (users.length === 0) {
      console.log('✅ All users already have trading enabled!');
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let alreadyEnabledCount = 0;

    for (const user of users) {
      console.log(`\n📝 Processing user: ${user.username || user.telegramId}`);
      console.log(`   Wallet: ${user.walletAddress}`);

      try {
        // Enable trading via gasless relayer
        const result = await enableTrading(user.encryptedPrivateKey);

        if (result.success) {
          if (result.alreadyEnabled) {
            console.log('   ℹ️  Trading was already enabled on-chain');
            alreadyEnabledCount++;
          } else {
            console.log(`   ✅ Trading enabled! Tx: ${result.txHash}`);
            successCount++;
          }

          // Update database
          await prisma.user.update({
            where: { id: user.id },
            data: { tradingEnabled: true },
          });

          console.log('   💾 Database updated');
        } else {
          console.log('   ❌ Failed to enable trading');
          failCount++;
        }

        // Wait a bit between users to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`   ❌ Error for user ${user.id}:`, error);
        failCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary:');
    console.log(`   ✅ Successfully enabled: ${successCount}`);
    console.log(`   ℹ️  Already enabled: ${alreadyEnabledCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   📊 Total processed: ${users.length}`);
    console.log('='.repeat(60) + '\n');

    if (failCount > 0) {
      console.log('⚠️  Some users failed. Check logs above for details.');
    } else {
      console.log('🎉 All users have trading enabled!');
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
