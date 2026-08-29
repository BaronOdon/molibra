#!/usr/bin/env node
/**
 * Molibra - command line.
 *
 *   molibra keys                          generate a keypair
 *   molibra node [options]                run a node (RPC + audit surface)
 *   molibra mine  --miner 0x.. -n 5       mine n blocks and exit
 *   molibra info                          print chain status
 *   molibra sync  --peer http://host:port pull and verify blocks from a peer
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Node } from './node.js';
import { Chain } from './chain.js';
import { generatePrivateKey, privateToAddress, toChecksumAddress, toHex } from './crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else if (token.startsWith('-') && token.length === 2) {
      args[token.slice(1)] = argv[++i];
    } else {
      args._.push(token);
    }
  }
  return args;
}

function makeNode(args) {
  return new Node({
    genesisPath: args.genesis ? resolve(args.genesis) : join(ROOT, 'genesis.json'),
    dataDir: args.datadir ? resolve(args.datadir) : join(ROOT, 'data'),
    miner: args.miner ?? null,
    peers: args.peers ? String(args.peers).split(',').map((p) => p.trim()) : [],
    minGasPrice: args.gasprice ? BigInt(args.gasprice) : 1000000000n,
  });
}

function formatMoli(wei, decimals = 18) {
  const base = 10n ** BigInt(decimals);
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const commands = {
  keys() {
    const priv = generatePrivateKey();
    const address = privateToAddress(priv);
    console.log('private key :', toHex(priv));
    console.log('address     :', toChecksumAddress(address));
    console.log('');
    console.log('Keep the private key secret. Anyone holding it controls the account.');
  },

  info(args) {
    const genesisPath = args.genesis ? resolve(args.genesis) : join(ROOT, 'genesis.json');
    const dataDir = args.datadir ? resolve(args.datadir) : join(ROOT, 'data');
    const chain = new Chain(Chain.loadGenesis(genesisPath), dataDir).init();
    console.log(`chain       : ${chain.genesis.name} (${chain.genesis.symbol})`);
    console.log(`chain id    : ${chain.chainId}`);
    console.log(`height      : ${chain.height}`);
    console.log(`head        : ${chain.head.hash}`);
    console.log(`difficulty  : ${chain.head.header.difficulty}`);
    console.log(`accounts    : ${chain.state.accounts.size}`);
    if (args.balance) {
      const balance = chain.state.balanceOf(args.balance);
      console.log(`balance     : ${formatMoli(balance)} ${chain.genesis.symbol} (${balance} wei)`);
    }
  },

  async mine(args) {
    if (!args.miner) throw new Error('--miner 0x... is required');
    const node = makeNode(args);
    const count = Number(args.n ?? args.blocks ?? 1);
    console.log(`mining ${count} block(s) to ${node.miner} at difficulty ${node.chain.head.header.difficulty}`);
    const started = Date.now();
    node.mineBlocks(count, (block) => {
      console.log(`  #${block.header.number}  ${block.hash}  txs=${block.transactions.length}  diff=${block.header.difficulty}`);
    });
    const balance = node.chain.state.balanceOf(node.miner);
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(2)}s`);
    console.log(`miner balance: ${formatMoli(balance)} ${node.chain.genesis.symbol}`);
  },

  async node(args) {
    const node = makeNode(args);
    if (args.treasury) node.enableTreasury(args.claim ? { claimAmount: BigInt(args.claim) } : {});
    const host = args.host ?? '127.0.0.1';
    const port = Number(args.port ?? 8545);
    await node.start({ host, port });

    console.log(`Molibra node`);
    console.log(`  chain     : ${node.chain.genesis.name} (${node.chain.genesis.symbol}), id ${node.chain.chainId}`);
    console.log(`  height    : ${node.chain.height}`);
    console.log(`  rpc       : ${node.rpcUrl}`);
    console.log(`  audit     : ${node.rpcUrl}/molibra`);
    if (node.peers.size) console.log(`  peers     : ${[...node.peers].join(', ')}`);

    if (node.peers.size) {
      for (const peer of node.peers) {
        try {
          const adopted = await node.syncFrom(peer);
          if (adopted) console.log(`  synced ${adopted} block(s) from ${peer}`);
        } catch (error) {
          console.log(`  sync from ${peer} failed: ${error.message}`);
        }
      }
    }

    if (args.mine) {
      if (!node.miner) throw new Error('--mine needs --miner 0x...');
      console.log(`  mining    : to ${node.miner}`);
      node.startMining((block) => {
        console.log(`  #${block.header.number}  ${block.hash}  txs=${block.transactions.length}`);
      });
    }

    const shutdown = async () => {
      console.log('\nstopping...');
      await node.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },


  treasury(args) {
    const node = makeNode(args);
    const t = node.enableTreasury(args.claim ? { claimAmount: BigInt(args.claim) } : {});
    const d = t.describe();
    console.log(`treasury    : ${d.address}`);
    console.log(`balance     : ${formatMoli(BigInt(d.balance))} MOLI`);
    console.log(`claim size  : ${formatMoli(BigInt(d.claimAmount))} MOLI`);
    console.log(`claims made : ${d.claimsMade}`);
    console.log(`fundable    : ${d.claimsFundable} more claim(s)`);
    console.log(`key file    : ${t.keyFile}`);
    if (args.to) {
      const hash = t.send(args.to, args.amount ? BigInt(args.amount) : undefined);
      console.log(`sent        : ${hash}`);
      console.log('mine a block for it to confirm.');
    }
  },

  async sync(args) {
    if (!args.peer) throw new Error('--peer http://host:port is required');
    const node = makeNode(args);
    const adopted = await node.syncFrom(args.peer);
    console.log(`adopted ${adopted} block(s); height is now ${node.chain.height}`);
  },
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'info';

if (!commands[command]) {
  console.error(`unknown command: ${command}`);
  console.error('commands: keys, info, mine, node, sync');
  process.exit(1);
}

Promise.resolve(commands[command](args)).catch((error) => {
  console.error('error:', error.message);
  process.exit(1);
});
