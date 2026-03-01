/**
 * Custom Emoji utilities for Telegram Premium animated emojis.
 * Usage: parse_mode must be 'HTML' when using ce() in messages.
 *
 * How to find new emoji IDs:
 *   1. Send a custom emoji to the bot
 *   2. Use /emojiid command — bot replies with the ID
 *   3. Add it to the EMOJI map below
 */

/** Render a Telegram custom (Premium) emoji. Requires parse_mode: 'HTML'. */
export function ce(id: string, fallback: string): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/** Escape HTML special characters in plain text for HTML parse_mode. */
export function esc(text: string | number): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** HTML bold */
export const b = (text: string | number) => `<b>${text}</b>`;
/** HTML italic */
export const i = (text: string | number) => `<i>${text}</i>`;
/** HTML code (monospace) */
export const c = (text: string | number) => `<code>${text}</code>`;
/** HTML underline */
export const u = (text: string | number) => `<u>${text}</u>`;
/** HTML link */
export const a = (text: string, url: string) => `<a href="${url}">${text}</a>`;

// ─── Known Custom Emoji IDs ────────────────────────────────────────────────────
// Add more IDs here as you discover them via /emojiid

export const EMOJI: Record<string, string> = {
  // Main menu stats
  polymarket: '5836670421356781641', // Polymarket logo
  cherry:     '5843941440211655941', // 🌸 title
  star:       '5420534836798458790', // 💙 tagline
  arrow:      '5769403330761593044', // 💛 positions value
  money:      '5897958754267174109', // 💰 tradable balance
  chat:       '5985630530111020079', // 💬 open limit orders
  briefcase:  '5967389567781703494', // 💼 net worth
  // Categories page
  marketsTitle: '5348148965525197476', // 🤑 browse events title
  trending:     '5451904668043065609', // 🌎 trending
  politics:     '6107164107289399166', // 🇺🇸 politics
  sports:       '4911359518895506231', // 🏈 sports
  crypto:       '5244837092042750681', // 🔥 crypto
  business:     '5855155960598762938', // 📈 business
  popCulture:   '5231200819986047254', // 📹 pop culture
  // Referral page
  refHub:    '5931347928810526429', // 👥 referral hub title
  refCode:   '6005570495603282482', // 🔑 your code
  refLink:   '5778168620278354602', // 🔗 invite link
  tierUser:  '5920344347152224466', // 👤 tier metrics
  tier1:     '5440539497383087970', // 🥇 tier 1
  tier2:     '5447203607294265305', // 🥈 tier 2
  tier3:     '5453902265922376865', // 🥉 tier 3
  earnings:  '5967390100357648692', // 💵 earnings dashboard
  // Event detail page
  eventTitle:  '5843941440211655941', // 🌸 event title prefix
  priceUp:     '6030861234432121355', // ⬆️ YES/Up price
  priceDown:   '5888645706096319818', // ⬇️ NO/Down price
  eventStats:  '5348148965525197476', // 🤑 volume/stats (marketsTitle alias)
  vol:         '5875291072225087249', // 📊 total volume
  liq:         '6005553599201940235', // 💧 total liquidity
  clock:       '5985616167740379273', // ⏰ end date
  marketArrow: '5884123981706956210', // ➡️ market N/total
  lightning:   '5355160022894539220', // ⚡️ quick buy
  // Wallet page
  walletPurse:    '5424976816530014958', // 👛 wallet title
  ethDeposit:     '5834797454838468470', // 🔹 EVM/ETH deposit
  solanaDeposit:  '5827847162666425855', // 🟣 solana deposit
  baseDeposit:    '5848124407645478260', // 🟦 base deposit
  usdc:           '5837102533721460863', // 💲 USDC / balance
};

/**
 * Returns true if the EMOJI map has enough entries to use across the bot.
 * Use this to decide whether to enable HTML-mode custom emoji globally.
 */
export function emojiReady(): boolean {
  return Object.keys(EMOJI).length >= 5;
}