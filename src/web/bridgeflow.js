/*
 * Molibra - the bMOLI -> MOLI crossing as one function, shared by pages
 * (/molibra/buy "Receber como MOLI"; /molibra/ponte follows the same steps).
 *
 *   1. bMOLI.transfer(return vault, amount) on Ethereum       - signature
 *   2. bMOLI.transfer(fee address, return fee) on Ethereum   - signature
 *      (operator rule, 6 Oct 2026: every cost is paid by its user; the bridge
 *       bot relays only returns whose sender paid this fee)
 *   3. the bridge bot proves it and returns the MOLI to the SENDER on Molibra
 *      (automatic up to its rolling cap); this polls until it lands
 *   4. switches the wallet to Molibra (adding the network if needed)
 *
 * It holds no key; every transaction is signed in the reader's wallet.
 * DOM-free: progress goes to onStep(key, state, detail).
 */
(function (root) {
  const BMOLI = '0xa302877efb74f567f3605851194b46f1d5746822';
  const VAULT = '0x0173f059ce912bb442296f3763746637f7d20fc1';
  const FEE_ADDRESS = '0xf51ac8fd4112bf1d45fd5c38d5abfe0c61ec3f5a';
  const TRANSFER = '0xa9059cbb';
  const MOLIBRA_HEX = '0x4f02';
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const vaultData = (wei) => TRANSFER + word(VAULT) + word(wei);
  const feeData = (wei) => TRANSFER + word(FEE_ADDRESS) + word(wei);
  /** header commit + return on Molibra (2 x 500,000 gas) x gas price x 2, rounded up to a whole bMOLI, floor 1. */
  function returnFeeWei(molibraGasPriceWei) {
    const w = 2n * 1000000n * BigInt(molibraGasPriceWei);
    const whole = (w + 10n ** 18n - 1n) / 10n ** 18n * 10n ** 18n;
    return whole > 10n ** 18n ? whole : 10n ** 18n;
  }
  /** What the bot can still return automatically right now, from /molibra's outbound.botCap. */
  function capFree(identity) {
    const c = identity && identity.outbound && identity.outbound.botCap;
    if (!c) return null;
    return BigInt(c.cap) - BigInt(c.usedInWindow);
  }

  async function waitReceipt(ethRpc, hash) {
    for (let i = 0; i < 200; i++) {
      const r = await ethRpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) { if (r.status !== '0x1') throw new Error('reverted: ' + hash); return r; }
      await sleep(4000);
    }
    throw new Error('not mined in time: ' + hash);
  }

  /**
   * Run steps 1-4. `wallet` is an EIP-1193 provider already on Ethereum
   * mainnet; `ethRpc(method, params)` reads Ethereum; `node` is the Molibra
   * origin (its /molibra serves JSON-RPC).
   */
  async function returnToMolibra({ wallet, ethRpc, node, account, wei, fee, onStep = () => {} }) {
    const mrpc = async (method, params) => {
      const r = await fetch(node + '/molibra', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    };
    const base = BigInt(await mrpc('eth_getBalance', [account, 'latest']).catch(() => '0x0'));
    const blk = await ethRpc('eth_getBlockByNumber', ['latest', false]);
    const bf = BigInt(blk.baseFeePerGas); const tip = 50000000n;     // 0.05 gwei, as /molibra/return
    const fees = { maxPriorityFeePerGas: '0x' + tip.toString(16), maxFeePerGas: '0x' + (bf * 2n + tip).toString(16) };

    onStep('vault', 'now', 'sign');
    const h1 = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: account, to: BMOLI, value: '0x0', data: vaultData(wei), ...fees }] });
    onStep('vault', 'now', h1);
    await waitReceipt(ethRpc, h1);
    onStep('vault', 'done', h1);

    onStep('fee', 'now', 'sign');
    const h2 = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: account, to: BMOLI, value: '0x0', data: feeData(fee), ...fees }] });
    onStep('fee', 'now', h2);
    await waitReceipt(ethRpc, h2);
    onStep('fee', 'done', h2);

    onStep('return', 'now');
    const target = base + BigInt(wei) - 10n ** 15n;
    let landed = base;
    for (;;) {
      try { landed = BigInt(await mrpc('eth_getBalance', [account, 'latest'])); if (landed >= target) break; } catch (e) {}
      await sleep(30000);
    }
    onStep('return', 'done', landed);

    onStep('net', 'now');
    try {
      try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MOLIBRA_HEX }] }); }
      catch (e) {
        if (e && e.code === 4902) {
          await wallet.request({ method: 'wallet_addEthereumChain', params: [{ chainId: MOLIBRA_HEX, chainName: 'Molibra',
            nativeCurrency: { name: 'MOLI', symbol: 'MOLI', decimals: 18 }, rpcUrls: [node + '/molibra'] }] });
        } else throw e;
      }
      onStep('net', 'done');
    } catch (e) { onStep('net', 'bad', e.message); }
    return { vaultTx: h1, feeTx: h2, molibraBalance: landed };
  }

  const api = { BMOLI, VAULT, FEE_ADDRESS, vaultData, feeData, returnFeeWei, capFree, returnToMolibra };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MolibraReturn = api;
})(typeof window !== 'undefined' ? window : globalThis);
