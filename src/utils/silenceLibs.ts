/**
 * Silences known console.log / console.error noise from third-party libs that
 * bypass our winston logger. Specifically:
 *   - @polymarket/builder-relayer-client/dist/client.js
 *   - @polymarket/builder-relayer-client/dist/builder/proxy.js
 *   - @polymarket/builder-relayer-client/dist/builder/safe.js
 *   - @polymarket/builder-signing-sdk/dist/config.js
 *
 * Install once at process startup BEFORE any module that imports the relayer
 * client. We monkey-patch console.log and console.error globally; legitimate
 * application logs go through `logger` (winston) and are unaffected.
 */

const NOISE_PATTERNS: RegExp[] = [
  // client.js
  /^Executing (proxy|safe) transactions\.\.\.$/,
  /^Client side (proxy|safe|deploy) request creation took: [\d.]+ seconds$/,
  /^Deploying safe /,
  /^Waiting for transaction [a-f0-9-]+ matching states:/i,
  /^txn [a-f0-9-]+ failed onchain! Transaction hash:/i,
  /^Transaction not found or not in given states, timing out!$/,
  // builder/proxy.js + builder/safe.js
  /^Created (Proxy|Safe) Transaction Request:?\s*$/,
  /^Error estimating gas for proxy transaction, using default gas limit:/,
  // builder-signing-sdk
  /^error calling remote signer/,
];

function isRelayerReqDump(arg: unknown): boolean {
  if (typeof arg !== 'object' || arg === null) return false;
  const obj = arg as Record<string, unknown>;
  // Match the request object the relayer client dumps right after the marker.
  // SAFE / PROXY shapes both contain `proxyWallet` and `signatureParams`.
  return 'proxyWallet' in obj && 'signatureParams' in obj && 'type' in obj;
}

let installed = false;

export function silenceThirdPartyLogs(): void {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && NOISE_PATTERNS.some(p => p.test(first))) return;
    if (args.length === 1 && isRelayerReqDump(first)) return;
    origLog(...args);
  };

  console.error = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && NOISE_PATTERNS.some(p => p.test(first))) return;
    origError(...args);
  };
}
