/**
 * Molibra - contract execution.
 *
 * A thin, deliberate wrapper around @ethereumjs/evm. Molibra does not
 * implement its own virtual machine: a consensus bug in a hand-rolled EVM is
 * unrecoverable, and there is no credit for writing one badly.
 *
 * HARDFORK: shanghai. Not an idle default - solc 0.8.20 and later emit PUSH0
 * unless told otherwise, and on a pre-shanghai target that dies as `invalid
 * opcode` with no revert reason, which reads like a broken contract rather
 * than a mis-set compiler. The bridge work lost time to exactly that against
 * a paris target. Shanghai accepts what a current compiler produces.
 *
 * ⛔ The EVM reaches state ONLY through MolibraStateManager, which exposes
 * accounts, code and storage. The token registry and vote keys are not on
 * that interface, so contract bytecode cannot reach them. See the note at the
 * top of evmstate.js before widening anything here.
 */

import { createEVM } from '@ethereumjs/evm';
import { Common, Mainnet } from '@ethereumjs/common';
import { Address } from '@ethereumjs/util';

import { MolibraStateManager, toEvmAddress } from './evmstate.js';
import { toHex, fromHex, normalizeAddress } from './crypto.js';

export const HARDFORK = 'shanghai';

/** One Common per chain id; building it per call is pure overhead. */
const commons = new Map();
function commonFor(chainId) {
  const key = String(chainId);
  if (!commons.has(key)) {
    commons.set(key, new Common({ chain: Mainnet, hardfork: HARDFORK, params: {} }));
  }
  return commons.get(key);
}

/**
 * Run one message call or contract creation against `state`.
 *
 * Mutates `state` on success. On failure the EVM's own checkpoint/revert has
 * already unwound every write, so the caller sees the state it passed in -
 * but the caller still owes the gas, exactly as on Ethereum.
 *
 * @returns {Promise<{
 *   gasUsed: bigint, returnValue: Uint8Array, createdAddress: string|null,
 *   logs: Array<{address: string, topics: string[], data: string}>,
 *   failed: boolean, error: string|null
 * }>}
 */
export async function runEvm(state, {
  from, to = null, value = 0n, data = new Uint8Array(0),
  gasLimit, chainId = 20226n, blockNumber = 0n, timestamp = 0n,
  coinbase = '0x0000000000000000000000000000000000000000',
  gasPrice = 0n,
}) {
  const stateManager = new MolibraStateManager(state);
  const evm = await createEVM({ common: commonFor(chainId), stateManager });

  // ⛔ The sender's nonce belongs to Molibra, not to the EVM.
  //
  // runCall() bumps the caller's nonce itself, imitating a transaction. Here
  // that is wrong twice over: applyTransaction already bumps it exactly once,
  // so the account would advance by two; and the EVM's bump happens OUTSIDE
  // its own checkpoint, so it survives a revert - which is how a failed call
  // was silently moving the state root and, with it, consensus.
  //
  // A reverted transaction must still consume its nonce. That is the
  // validator's job, on every transaction, whether it succeeded or not. So
  // the value is captured here and restored afterwards, and applyTransaction
  // remains the single place an externally owned account's nonce moves.
  const senderNonce = state.nonceOf(from);

  const result = await evm.runCall({
    caller: toEvmAddress(from),
    origin: toEvmAddress(from),
    to: to ? toEvmAddress(to) : undefined,
    value: BigInt(value),
    data: data instanceof Uint8Array ? data : fromHex(data),
    gasLimit: BigInt(gasLimit),
    gasPrice: BigInt(gasPrice),
    block: {
      header: {
        number: BigInt(blockNumber),
        timestamp: BigInt(timestamp),
        coinbase: toEvmAddress(coinbase),
        // Molibra is proof-of-work, so DIFFICULTY is meaningful and
        // PREVRANDAO is not. Shanghai reads the field as prevRandao; a node
        // must not let a contract observe anything nodes could disagree on,
        // so it is pinned to zero rather than fed the block difficulty.
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: BigInt(gasLimit),
        baseFeePerGas: 0n,
      },
    },
  });

  // Restore it whatever happened - success, revert or out of gas. A contract
  // that CREATEs another contract still advances ITS own nonce, which is the
  // EVM's business and is left alone; this touches only the sender.
  const sender = normalizeAddress(from);
  const current = state.get(sender);
  if (current.nonce !== senderNonce) {
    state.set(sender, { balance: current.balance, nonce: senderNonce });
  }

  const exec = result.execResult;
  return {
    gasUsed: exec.executionGasUsed,
    returnValue: exec.returnValue ?? new Uint8Array(0),
    createdAddress: result.createdAddress ? normalizeAddress(result.createdAddress.toString()) : null,
    logs: (exec.logs ?? []).map(([address, topics, logData]) => ({
      address: normalizeAddress(toHex(address)),
      topics: topics.map((t) => toHex(t)),
      data: toHex(logData),
    })),
    failed: exec.exceptionError !== undefined,
    error: exec.exceptionError ? String(exec.exceptionError.error) : null,
  };
}

/**
 * Read-only execution for eth_call and eth_estimateGas.
 *
 * Runs against a CLONE, so nothing a call does can reach the real state -
 * including a call that a wallet sends to a contract with a side effect.
 */
export async function simulate(state, params) {
  return runEvm(state.clone(), params);
}

export { Address };
