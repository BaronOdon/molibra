// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MolibraAnchor - Molibra's history, written where rewriting it is expensive.
 *
 * ## Why this contract exists
 *
 * Molibra's defence against rewritten history is its accumulated proof of work,
 * and that work is small: a valid header can be mined privately in seconds. The
 * chain's existing answer is `MAX_REORG_DEPTH` - refuse any reorg deeper than
 * 128 blocks - which its own SECURITY.md calls a trade rather than a win,
 * because it also refuses the honest chain a partitioned node should adopt.
 *
 * This contract replaces stubbornness with borrowed finality. A publisher
 * records, on Ethereum, that at Molibra height H the block was `blockHash` with
 * cumulative work W. Once that record is buried under enough Ethereum blocks,
 * rewriting Molibra below H requires rewriting Ethereum. Molibra nodes read
 * these anchors and refuse, unconditionally, any reorg that forks below the
 * deepest confirmed one - see `permitsReorgFrom` in src/anchor.js.
 *
 * ## What it deliberately is not
 *
 * ⛔ **It is not a consensus rule of Molibra.** Molibra decides what it accepts;
 * this is a place to write down what it accepted. A contract that could *make*
 * Molibra accept something would be a second consensus with a single writer.
 *
 * ⛔ **It does not make the publisher honest.** A publisher can anchor a chain
 * nobody else saw. The only misbehaviour provable from the data alone is
 * **equivocation** - two different attestations at one height - and that is
 * what `proveEquivocation` slashes. Everything else is a trust assumption, and
 * it is named rather than hidden: see `publisherOf`.
 *
 * ⛔ **A bond is only collateral if the bonded asset has a market.** This
 * contract takes a bond in an arbitrary ERC-20 chosen at deployment. If that
 * token has no liquidity, the bond is a **commitment device, not collateral**,
 * and nothing here should be described as economically secured. Stating this in
 * the contract rather than the docs is deliberate: the docs get summarised.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MolibraAnchor {
    struct Anchor {
        bytes32 blockHash;
        uint256 cumulativeWork;
        uint256 ethBlock;      // the Ethereum block this was recorded in
        address publisher;
    }

    /// Molibra height => what was attested there.
    mapping(uint256 => Anchor) public anchors;

    /// Every height ever anchored, in order, so a reader needs no event index.
    uint256[] public heights;

    /// The highest Molibra height anchored so far. Monotonic by construction.
    uint256 public tipHeight;
    uint256 public tipWork;

    /// Bonds, and whether a publisher has been caught attesting two histories.
    IERC20 public immutable bondToken;
    uint256 public immutable minimumBond;
    mapping(address => uint256) public bondOf;
    mapping(address => bool) public slashed;

    /// Set once, at deployment, and never afterwards: whoever wrote genesis.
    address public immutable deployer;

    event Anchored(
        uint256 indexed height, bytes32 blockHash, uint256 cumulativeWork, address publisher);
    event Bonded(address indexed publisher, uint256 amount, uint256 total);
    event Equivocation(
        address indexed publisher, uint256 indexed height, bytes32 a, bytes32 b, uint256 slashedAmount);
    event Withdrawn(address indexed publisher, uint256 amount);

    error NotBonded();
    error AlreadySlashed();
    error HeightNotIncreasing(uint256 given, uint256 tip);
    error WorkNotIncreasing(uint256 given, uint256 tip);
    error EmptyAnchor();
    error NothingToProve();
    error NotEquivocation();
    error TransferFailed();
    error StillActive();

    /**
     * @param bondToken_   the ERC-20 a publisher must bond. ⚠ If it has no
     *                     market, this bond is a commitment device, not
     *                     collateral - see the contract header.
     * @param minimumBond_ what a publisher must hold bonded to anchor at all.
     */
    constructor(IERC20 bondToken_, uint256 minimumBond_) {
        bondToken = bondToken_;
        minimumBond = minimumBond_;
        deployer = msg.sender;
    }

    // ------------------------------------------------------------------ bonds

    /// Post a bond. The publisher must have approved this contract first.
    function bond(uint256 amount) external {
        if (!bondToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        bondOf[msg.sender] += amount;
        emit Bonded(msg.sender, amount, bondOf[msg.sender]);
    }

    /**
     * Withdraw a bond.
     *
     * ⛔ Refused while the publisher's most recent anchor is still inside the
     * window a Molibra node would treat as unconfirmed. Otherwise a publisher
     * could anchor a false chain and remove the bond in the same block, which
     * would make the bond theatre.
     */
    function withdraw(uint256 amount) external {
        if (slashed[msg.sender]) revert AlreadySlashed();
        if (block.number < lastAnchorBlock[msg.sender] + WITHDRAW_DELAY) revert StillActive();
        bondOf[msg.sender] -= amount;
        if (!bondToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// Ethereum blocks a publisher must wait after their last anchor before
    /// unbonding. Longer than the confirmation depth a Molibra node uses (96),
    /// so the bond is always still there when an anchor becomes binding.
    uint256 public constant WITHDRAW_DELAY = 128;
    mapping(address => uint256) public lastAnchorBlock;

    // ---------------------------------------------------------------- anchors

    /**
     * Record one anchor.
     *
     * Both monotonicity checks are consensus-shaped rather than cosmetic:
     *
     *   - **height must strictly increase.** Anchoring an older height would let
     *     a publisher re-attest history after the fact, which is the thing the
     *     whole design exists to prevent.
     *   - **cumulative work must strictly increase.** A higher block carrying
     *     less accumulated work is not a Molibra chain, so accepting it would
     *     anchor something that could not have happened.
     *
     * A rejected anchor reverts rather than being stored-and-flagged: unlike the
     * node, this contract is the record itself, and a record containing entries
     * it says are wrong is worse than one that refused them.
     */
    function anchor(uint256 height, bytes32 blockHash, uint256 cumulativeWork) external {
        if (bondOf[msg.sender] < minimumBond) revert NotBonded();
        if (slashed[msg.sender]) revert AlreadySlashed();
        if (blockHash == bytes32(0) || cumulativeWork == 0) revert EmptyAnchor();
        if (heights.length != 0) {
            if (height <= tipHeight) revert HeightNotIncreasing(height, tipHeight);
            if (cumulativeWork <= tipWork) revert WorkNotIncreasing(cumulativeWork, tipWork);
        }

        anchors[height] = Anchor(blockHash, cumulativeWork, block.number, msg.sender);
        heights.push(height);
        tipHeight = height;
        tipWork = cumulativeWork;
        lastAnchorBlock[msg.sender] = block.number;

        emit Anchored(height, blockHash, cumulativeWork, msg.sender);
    }

    // --------------------------------------------------------- equivocation

    /**
     * ⛔⛔ Slash a publisher who signed two different attestations for one
     * Molibra height.
     *
     * The proof is the pair of signatures itself: nothing about Molibra needs to
     * be verified here, and deliberately so. This contract cannot tell which of
     * two Molibra chains is real - that is precisely the question it has no
     * authority over. What it *can* tell, with certainty and cheaply, is that
     * one key attested to both. That is a lie regardless of which one was true,
     * and it is the only publisher fault that is provable on this side.
     *
     * The digest must match `anchorDigest` in src/anchor.js exactly. One
     * encoder, two implementations, and the harness runs both against each
     * other - because a mismatch here would mean an unslashable liar.
     */
    function proveEquivocation(
        uint256 height,
        bytes32 hashA, uint256 workA, bytes calldata sigA,
        bytes32 hashB, uint256 workB, bytes calldata sigB
    ) external {
        if (hashA == hashB && workA == workB) revert NotEquivocation();

        address a = _recover(digest(height, hashA, workA), sigA);
        address b = _recover(digest(height, hashB, workB), sigB);
        if (a != b || a == address(0)) revert NothingToProve();
        if (slashed[a]) revert AlreadySlashed();

        slashed[a] = true;
        uint256 amount = bondOf[a];
        bondOf[a] = 0;

        // The slashed bond goes to whoever proved it. The prover paid gas to
        // make a lie public; paying them out of the liar's bond is what makes
        // watching the chain worth somebody's while.
        if (amount != 0 && !bondToken.transfer(msg.sender, amount)) revert TransferFailed();

        emit Equivocation(a, height, hashA, hashB, amount);
    }

    /// The exact bytes a publisher signs. Mirrors `anchorDigest` in src/anchor.js.
    function digest(uint256 height, bytes32 blockHash, uint256 cumulativeWork)
        public pure returns (bytes32)
    {
        return keccak256(abi.encodePacked("molibra:anchor:v1", blockHash, height, cumulativeWork));
    }

    /**
     * Recover a signer from a 65-byte signature.
     *
     * ⚠ **Low-s only (EIP-2).** Without this the same attestation exists under
     * two valid signatures, and a publisher caught equivocating could argue the
     * second was somebody else's forgery. Molibra enforces the same rule on its
     * own transactions in src/limits.js; the two must not disagree.
     */
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(hash, v, r, s);
    }

    // ------------------------------------------------------------- reading

    function anchorCount() external view returns (uint256) {
        return heights.length;
    }

    /**
     * The deepest anchor with at least `confirmations` Ethereum blocks on top,
     * which is the only anchor a Molibra node should treat as binding. Returns
     * height 0 with a zero hash when nothing qualifies, so a caller can tell
     * "no floor" from "a floor at genesis".
     *
     * ⚠ Walks backwards from the tip. Bounded by `maxScan` because an unbounded
     * loop over a list anyone may extend is a gas bomb aimed at the reader.
     */
    function finalized(uint256 confirmations, uint256 maxScan)
        external view returns (uint256 height, bytes32 blockHash, uint256 cumulativeWork)
    {
        uint256 n = heights.length;
        uint256 scanned = 0;
        while (n != 0 && scanned < maxScan) {
            n--;
            scanned++;
            uint256 h = heights[n];
            Anchor storage a = anchors[h];
            if (slashed[a.publisher]) continue;
            if (block.number >= a.ethBlock + confirmations) {
                return (h, a.blockHash, a.cumulativeWork);
            }
        }
        return (0, bytes32(0), 0);
    }
}
