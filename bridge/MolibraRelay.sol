// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./MolibraProver.sol";

/**
 * MolibraRelay — a Molibra light client living on Ethereum.
 *
 * ## The problem this solves
 *
 * A single Molibra header with valid proof of work proves only that somebody
 * did *one block's* work. Anyone can mine such a header privately and hand over
 * a perfectly valid inclusion proof for a transaction no honest node ever saw.
 * A bridge built on one header is therefore worth exactly one block of work,
 * and Molibra's blocks are cheap.
 *
 * The fix is the one every serious relay uses, and it has three parts, all of
 * which have to be present or the other two are decoration:
 *
 *   1. **Follow the retarget rule.** A header's difficulty is not something the
 *      submitter may declare. It is `parent.difficulty ± parent.difficulty/16`
 *      depending on whether the block came faster than the target interval,
 *      floored at the network minimum - exactly what `nextDifficulty` does in
 *      src/block.js. Anchored to a checkpoint, this means a forger cannot walk
 *      difficulty down to something cheap without burning many blocks doing it.
 *   2. **Accumulate work, and follow the heaviest chain**, not the longest.
 *      Adopting a fork means presenting more total work than the incumbent.
 *   3. **Bury it.** A transaction counts only when the work piled on top of its
 *      block exceeds a threshold. Forging then costs out-working the network
 *      for that many blocks, which is the same thing that secures the chain
 *      itself.
 *
 * ## The trust that remains, named rather than hidden
 *
 * The relay starts from a **checkpoint** the deployer supplies: a block hash,
 * its number, timestamp, difficulty and transaction root. Everything after it is
 * verified; the checkpoint itself is taken on faith. This is the same weak
 * subjectivity every light client has, and the honest way to state it is: a
 * reader who does not trust the checkpoint should check it against the chain
 * themselves, once, and then everything the relay says follows.
 */
contract MolibraRelay {
    struct Header {
        bytes32 parent;
        uint64  number;
        uint64  timestamp;
        uint128 difficulty;
        bytes32 txRoot;
        uint256 work;      // cumulative difficulty from the checkpoint
    }

    MolibraProver public immutable prover;
    uint256 public immutable targetSeconds;
    uint256 public immutable minimumDifficulty;
    bytes32 public immutable checkpoint;

    mapping(bytes32 => Header) public headers;
    /// Best chain by accumulated work, and the block at each height on it.
    bytes32 public best;
    uint256 public bestWork;
    mapping(uint256 => bytes32) public canonical;

    /// A reorg deeper than this must be applied in pieces; unbounded loops die.
    uint256 public constant MAX_REORG = 128;

    event Extended(bytes32 indexed blockHash, uint256 number, uint256 work);
    event Reorged(bytes32 indexed from, bytes32 indexed to, uint256 depth);

    error UnknownParent(bytes32 parent);
    error BadHeight(uint256 got, uint256 expected);
    error TimeDoesNotAdvance();
    error WrongDifficulty(uint256 got, uint256 expected);
    error ReorgTooDeep(uint256 depth);

    constructor(
        MolibraProver prover_,
        bytes32 checkpointHash,
        uint64 number,
        uint64 timestamp,
        uint128 difficulty,
        bytes32 txRoot,
        uint256 targetSeconds_,
        uint256 minimumDifficulty_
    ) {
        prover = prover_;
        targetSeconds = targetSeconds_;
        minimumDifficulty = minimumDifficulty_;
        checkpoint = checkpointHash;
        headers[checkpointHash] = Header({
            parent: bytes32(0), number: number, timestamp: timestamp,
            difficulty: difficulty, txRoot: txRoot, work: difficulty
        });
        best = checkpointHash;
        bestWork = difficulty;
        canonical[number] = checkpointHash;
    }

    /**
     * Molibra's retarget, reimplemented exactly.
     *
     * Getting this wrong in either direction is fatal and quiet: too permissive
     * and a forger declares an easy difficulty; too strict and honest headers
     * are rejected and the relay stalls. It adjusts by a sixteenth per block
     * and never falls below the network floor - see `nextDifficulty` in
     * src/block.js, which is the definition this must match.
     */
    function expectedDifficulty(uint256 parentDifficulty, uint256 elapsed)
        public view returns (uint256 next)
    {
        uint256 step = parentDifficulty / 16;
        if (step == 0) step = 1;
        next = elapsed < targetSeconds ? parentDifficulty + step : parentDifficulty - step;
        if (next < minimumDifficulty) next = minimumDifficulty;
    }

    /**
     * Take a run of headers, each the child of the last. Anyone may submit;
     * nothing here trusts the submitter, which is why anyone may.
     */
    function submit(bytes[] calldata headerRlps) external {
        bytes32 tip;
        for (uint256 i = 0; i < headerRlps.length; i++) {
            MolibraProver.Header memory parsed = prover.verifyHeader(headerRlps[i]);
            tip = _accept(headerRlps[i], parsed);
        }
        _chooseBest(tip);
    }

    function _accept(bytes calldata headerRlp, MolibraProver.Header memory parsed)
        private returns (bytes32 blockHash)
    {
        blockHash = parsed.blockHash;
        if (headers[blockHash].work != 0) return blockHash; // already known

        (bytes32 parentHash, uint256 timestamp) = _parentAndTime(headerRlp);
        Header memory parent = headers[parentHash];
        if (parent.work == 0) revert UnknownParent(parentHash);
        if (parsed.number != parent.number + 1) {
            revert BadHeight(parsed.number, parent.number + 1);
        }
        if (timestamp <= parent.timestamp) revert TimeDoesNotAdvance();

        uint256 expected = expectedDifficulty(parent.difficulty, timestamp - parent.timestamp);
        if (parsed.difficulty != expected) revert WrongDifficulty(parsed.difficulty, expected);

        headers[blockHash] = Header({
            parent: parentHash,
            number: uint64(parsed.number),
            timestamp: uint64(timestamp),
            difficulty: uint128(parsed.difficulty),
            txRoot: parsed.txRoot,
            work: parent.work + parsed.difficulty
        });
        emit Extended(blockHash, parsed.number, parent.work + parsed.difficulty);
    }

    /** Items 1 and 2 of the header: parentHash and timestamp. */
    function _parentAndTime(bytes calldata headerRlp)
        private pure returns (bytes32 parentHash, uint256 timestamp)
    {
        bytes memory data = headerRlp;
        (MolibraRLP.Item[] memory items, uint256 count, ) = MolibraRLP.items(data, 11);
        require(count == 11, "a molibra header has 11 items");
        parentHash = MolibraRLP.toBytes32(data, items[1]);
        timestamp = MolibraRLP.toUint(data, items[2]);
    }

    /** Heaviest chain wins; on a tie the incumbent keeps the head. */
    function _chooseBest(bytes32 candidate) private {
        if (candidate == bytes32(0)) return;
        uint256 work = headers[candidate].work;
        if (work <= bestWork) return;

        // Rewrite the canonical index back to the fork point. Bounded, because
        // this loop is driven by data a stranger supplied.
        bytes32 cursor = candidate;
        uint256 depth;
        while (cursor != bytes32(0) && canonical[headers[cursor].number] != cursor) {
            if (++depth > MAX_REORG) revert ReorgTooDeep(depth);
            canonical[headers[cursor].number] = cursor;
            cursor = headers[cursor].parent;
        }
        if (depth > 1) emit Reorged(best, candidate, depth);
        best = candidate;
        bestWork = work;
    }

    /* ------------------------------------------------------------ readers */

    /** Is this block on the best chain, and how much work is piled on top? */
    function workAbove(bytes32 blockHash) public view returns (bool onBest, uint256 buried) {
        Header memory h = headers[blockHash];
        if (h.work == 0) return (false, 0);
        onBest = canonical[h.number] == blockHash;
        buried = bestWork - h.work;
    }

    /**
     * The whole question a bridge should ask: is this transaction in a block on
     * the best chain, with at least `requiredWork` piled on top of it?
     *
     * Work, not a block count - a confirmation is only worth the difficulty
     * behind it, and counting blocks lets a forger present many cheap ones.
     */
    function isSettled(
        bytes32 blockHash,
        bytes32 txHash,
        bytes32[] calldata siblings,
        bool[] calldata siblingOnRight,
        uint256 requiredWork
    ) external view returns (bool) {
        (bool onBest, uint256 buried) = workAbove(blockHash);
        if (!onBest || buried < requiredWork) return false;
        return prover.merkleRoot(txHash, siblings, siblingOnRight) == headers[blockHash].txRoot;
    }
}

/**
 * MolibraBridge — releases against a settled transaction, and takes its
 * instructions FROM that transaction.
 *
 * Two things separate this from the test rig in MolibraProver.sol:
 *
 *   1. **It asks the relay, not a single header.** A transaction counts when
 *      it is on the heaviest known chain with enough work piled on top.
 *   2. **The recipient and the amount come out of the proved Molibra
 *      transaction**, not out of the caller's arguments. A bridge that lets the
 *      caller name the recipient has made the proof decoration: anybody proves
 *      any transaction and names themselves.
 *
 * The Molibra side of the instruction is an ordinary signed transaction whose
 * data is `BRIDGE_OUT ‖ recipient(20) ‖ amount(32)`. It moves nothing on
 * Molibra; it is a statement of intent that the sender signed, and the
 * signature is what the transaction hash commits to.
 */
contract MolibraBridge {
    MolibraRelay public immutable relay;
    address public immutable owner;
    uint256 public requiredWork;

    /// keccak256("bridgeOut(address,uint256)")[0:4] — computed, not guessed.
    bytes4 public constant BRIDGE_OUT = 0x9854175f;

    mapping(bytes32 => bool) public claimed;

    event Released(bytes32 indexed molibraTx, address indexed to, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    error NotOwner();
    error AlreadyClaimed();
    error NotSettled();
    error NotABridgeOut();
    error WrongTransaction();
    error Insufficient();

    constructor(MolibraRelay relay_, uint256 requiredWork_) payable {
        relay = relay_;
        owner = msg.sender;
        requiredWork = requiredWork_;
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    function setRequiredWork(uint256 value) external {
        if (msg.sender != owner) revert NotOwner();
        requiredWork = value;
    }

    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, ) = owner.call{ value: address(this).balance }("");
        require(ok, "withdraw failed");
    }

    /**
     * `rawTx` is the Molibra transaction itself. Its hash is the leaf in the
     * Merkle proof, so proving inclusion and reading the instruction are the
     * same act - there is no gap between "this was on the chain" and "this is
     * what it said".
     */
    function release(
        bytes32 blockHash,
        bytes calldata rawTx,
        bytes32[] calldata siblings,
        bool[] calldata siblingOnRight
    ) external {
        bytes32 txHash = keccak256(rawTx);
        if (claimed[txHash]) revert AlreadyClaimed();
        if (!relay.isSettled(blockHash, txHash, siblings, siblingOnRight, requiredWork)) {
            revert NotSettled();
        }

        (address recipient, uint256 amount) = decodeBridgeOut(rawTx);
        if (amount == 0 || amount > address(this).balance) revert Insufficient();

        claimed[txHash] = true;
        (bool ok, ) = payable(recipient).call{ value: amount }("");
        require(ok, "transfer failed");
        emit Released(txHash, recipient, amount);
    }

    /**
     * Read the instruction out of a legacy EIP-155 transaction: nine RLP items,
     * of which item 5 is the data. Nothing else about the transaction is
     * interpreted - the bridge does not care who signed it or what it paid,
     * only that it was mined and what it said.
     */
    function decodeBridgeOut(bytes memory rawTx)
        public pure returns (address recipient, uint256 amount)
    {
        (MolibraRLP.Item[] memory items, uint256 count, ) = MolibraRLP.items(rawTx, 9);
        require(count == 9, "not a legacy transaction");
        MolibraRLP.Item memory dataItem = items[5];
        if (dataItem.length != 4 + 20 + 32) revert NotABridgeOut();

        uint256 at = dataItem.offset;
        bytes4 tag;
        assembly { tag := mload(add(add(rawTx, 0x20), at)) }
        if (tag != BRIDGE_OUT) revert NotABridgeOut();

        uint256 addressWord;
        uint256 amountAt = at + 24;
        assembly {
            // 20 address bytes sit at at+4; load the 32 bytes ending there and
            // shift the leading 12 away.
            addressWord := mload(add(add(rawTx, 0x20), add(at, 4)))
            amount := mload(add(add(rawTx, 0x20), amountAt))
        }
        recipient = address(uint160(addressWord >> 96));
    }
}
