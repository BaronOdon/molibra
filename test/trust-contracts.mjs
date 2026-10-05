/**
 * V4PositionLocker and TokenVesting, run from contracts/artifacts/trust.json on
 * Molibra's own EVM (src/evm.js). No compiler needed: contracts/trust-build.mjs
 * writes the artifact.
 *
 * The locker's whole claim is "the liquidity cannot leave before the date", so
 * the test is built to catch the opposite: the mock PositionManager REFUSES any
 * liquidity decrease other than 0, and every early withdraw is expected to revert.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethereum-cryptography/keccak.js';
import { utf8ToBytes, bytesToHex } from 'ethereum-cryptography/utils.js';
import { State } from '../src/state.js';
import { runEvm, simulate } from '../src/evm.js';
import { toHex, fromHex } from '../src/crypto.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const art = JSON.parse(readFileSync(join(ROOT, 'contracts/artifacts/trust.json'), 'utf8')).contracts;

let pass = 0, fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${l}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? '  ' + d : ''}`); }
};

const sel = (s) => bytesToHex(keccak256(utf8ToBytes(s))).slice(0, 8);
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrW = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const errSel = (s) => '0x' + sel(s);

const eth = new State();
let block = 1n;
let now = 1_800_000_000n;
const OPERATOR = '0x' + '11'.repeat(20);
const STRANGER = '0x' + '22'.repeat(20);
const HEIR = '0x' + '33'.repeat(20);
const ETH = '0x' + '00'.repeat(20);

async function deploy(name, args = '') {
  const r = await runEvm(eth, { from: OPERATOR, to: null, data: fromHex(art[name].bytecode + args),
    gasLimit: 30_000_000n, blockNumber: block++, timestamp: now });
  if (r.failed) throw new Error(`${name} deploy failed: ${r.error}`);
  eth.bumpNonce(OPERATOR);
  return r.createdAddress;
}
async function send(from, to, data) {
  const r = await runEvm(eth, { from, to, data: fromHex('0x' + data), gasLimit: 10_000_000n,
    blockNumber: block++, timestamp: now });
  eth.bumpNonce(from);
  r.revert = toHex(r.returnValue).slice(0, 10);
  return r;
}
const read = async (to, data) => toHex((await simulate(eth, { from: OPERATOR, to, data: fromHex('0x' + data),
  gasLimit: 10_000_000n, blockNumber: block, timestamp: now })).returnValue);
const readUint = async (to, data) => BigInt(await read(to, data) || '0x0');
const readAddr = async (to, data) => '0x' + (await read(to, data)).slice(-40);

console.log('V4PositionLocker\n');

const pm = await deploy('MockPositionManager');
const TOKEN = '0x' + 'ab'.repeat(20);
const locker = await deploy('V4PositionLocker', addrW(pm));
check('locker deploys against a PositionManager', !!locker);
check('  and names it', (await readAddr(locker, sel('positionManager()'))) === pm.toLowerCase());
check('  it has no owner() at all', !art.V4PositionLocker.abi.some((f) => f.name === 'owner'));
for (const bad of ['decreaseLiquidity', 'emergencyWithdraw', 'setFee', 'transferOwnership', 'unlock', 'shorten']) {
  check(`  ABI has no ${bad}()`, !art.V4PositionLocker.abi.some((f) => f.type === 'function' && f.name === bad));
}

await send(OPERATOR, pm, sel('mint(address,uint256,uint256,address,address)') + addrW(OPERATOR) + word(414300) + word(10n ** 18n) + addrW(ETH) + addrW(TOKEN));
const unlockAt = now + 365n * 86400n;
const safeTransfer = (from, id, data) => sel('safeTransferFrom(address,address,uint256,bytes)')
  + addrW(from) + addrW(locker) + word(id) + word(0x80) + word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');

// ⛔ a date in the past is refused: a "lock" that is already open locks nothing
let r = await send(OPERATOR, pm, safeTransfer(OPERATOR, 414300, word(now - 1n)));
check('a lock dated in the past is refused', r.failed);
r = await send(OPERATOR, pm, safeTransfer(OPERATOR, 414300, word(unlockAt)));
check('locking = safeTransferFrom with the date', !r.failed, r.error ?? '');
check('  the locker now holds the position NFT', (await readAddr(pm, sel('ownerOf(uint256)') + word(414300))) === locker.toLowerCase());
const lockRec = await read(locker, sel('locks(uint256)') + word(414300));
check('  the lock records the sender as beneficiary', '0x' + lockRec.slice(2 + 24, 66) === OPERATOR);
check('  and the date', BigInt('0x' + lockRec.slice(66, 130)) === unlockAt);
check('  remaining() counts down from a year', (await readUint(locker, sel('remaining(uint256)') + word(414300))) === 365n * 86400n);

// ⛔ an NFT pushed by anything but the PositionManager is refused
r = await send(STRANGER, locker, sel('onERC721Received(address,address,uint256,bytes)') + addrW(STRANGER) + addrW(STRANGER) + word(7) + word(0x80) + word(32) + word(unlockAt));
check('a direct onERC721Received from a stranger is refused', r.failed && r.revert === errSel('NotPositionManager()'));

r = await send(OPERATOR, locker, sel('withdraw(uint256)') + word(414300));
check('withdraw before the date reverts StillLocked', r.failed && r.revert === errSel('StillLocked(uint64)'));
r = await send(STRANGER, locker, sel('withdraw(uint256)') + word(414300));
check('  and a stranger may not withdraw at all', r.failed && r.revert === errSel('NotBeneficiary()'));

r = await send(OPERATOR, locker, sel('collectFees(uint256)') + word(414300));
check('the beneficiary collects fees while locked', !r.failed, r.error ?? '');
check('  through DECREASE_LIQUIDITY(0) + TAKE_PAIR (the mock refuses anything else)', (await readUint(pm, sel('feeCollections()'))) === 1n);
check('  paid to the beneficiary', (await readAddr(pm, sel('lastTakeRecipient()'))) === OPERATOR);
r = await send(STRANGER, locker, sel('collectFees(uint256)') + word(414300));
check('  a stranger cannot collect', r.failed);

r = await send(OPERATOR, locker, sel('extend(uint256,uint64)') + word(414300) + word(unlockAt - 1n));
check('the date cannot be moved EARLIER', r.failed && r.revert === errSel('NotLater()'));
r = await send(OPERATOR, locker, sel('extend(uint256,uint64)') + word(414300) + word(unlockAt + 86400n));
check('  but it can be moved later', !r.failed);

r = await send(OPERATOR, locker, sel('setBeneficiary(uint256,address)') + word(414300) + addrW(HEIR));
check('the beneficiary may hand the role on', !r.failed);
r = await send(OPERATOR, locker, sel('collectFees(uint256)') + word(414300));
check('  after which the old one has no power', r.failed && r.revert === errSel('NotBeneficiary()'));

now = unlockAt + 86400n - 1n;
r = await send(HEIR, locker, sel('withdraw(uint256)') + word(414300));
check('one second before the extended date: still locked', r.failed);
now += 1n;
r = await send(HEIR, locker, sel('withdraw(uint256)') + word(414300));
check('at the date the beneficiary withdraws', !r.failed, r.error ?? '');
check('  and holds the NFT again', (await readAddr(pm, sel('ownerOf(uint256)') + word(414300))) === HEIR);
check('  the lock is gone', (await readUint(locker, sel('remaining(uint256)') + word(414300))) === 0n);

console.log('\nTokenVesting\n');

const tok = await deploy('MockERC20');
const start = now;
const CLIFF = 180n * 86400n, DURATION = 720n * 86400n;
const ctor = (t, b, s, c, d) => addrW(t) + addrW(b) + word(s) + word(c) + word(d);
let refused = false;
try { await deploy('TokenVesting', ctor(tok, OPERATOR, start, DURATION + 1n, DURATION)); } catch { refused = true; }
check('a cliff longer than the schedule is refused', refused);
const vest = await deploy('TokenVesting', ctor(tok, OPERATOR, start, CLIFF, DURATION));
check('vesting deploys', !!vest);
check('  no owner, no revoke', !art.TokenVesting.abi.some((f) => ['owner', 'revoke', 'rescue', 'setBeneficiary'].includes(f.name)));
const RESERVE = 40_000_000n * 10n ** 18n;
await send(OPERATOR, tok, sel('mint(address,uint256)') + addrW(vest) + word(RESERVE));
check('funded by a plain transfer', (await readUint(tok, sel('balanceOf(address)') + addrW(vest))) === RESERVE);
r = await send(STRANGER, vest, sel('release()'));
check('nothing releases before the cliff', r.failed && r.revert === errSel('NothingToRelease()'));
now = start + CLIFF;
check('at the cliff a quarter has vested (180 of 720 days)', (await readUint(vest, sel('releasable()'))) === RESERVE / 4n);
r = await send(STRANGER, vest, sel('release()'));
check('  anybody may call release()', !r.failed);
check('  and it pays only the beneficiary', (await readUint(tok, sel('balanceOf(address)') + addrW(OPERATOR))) === RESERVE / 4n
  && (await readUint(tok, sel('balanceOf(address)') + addrW(STRANGER))) === 0n);
now = start + DURATION + 1n;
await send(STRANGER, vest, sel('release()'));
check('after the schedule everything has been paid', (await readUint(tok, sel('balanceOf(address)') + addrW(OPERATOR))) === RESERVE);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
