// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MolibraSettlement — a bridge-out that settles for the price of a transaction.
 *
 * ## Why this exists beside MolibraRelay
 *
 * `MolibraRelay` verifies Molibra's proof-of-work itself: every header, every
 * difficulty retarget, heaviest chain by accumulated work. It trusts nothing
 * but the arithmetic. It is also, measured rather than guessed, **168,288 gas
 * per Molibra header** — and it needs a CONTIGUOUS chain of them from its
 * checkpoint, because `_accept` refuses a header whose parent it has not seen.
 * Molibra makes 5,760 blocks a day. That is ~0.97 million gas per day of chain
 * just to stand still, and the gap from an immutable checkpoint only ever
 * grows. A bridge whose settlement cost rises with the age of the chain is not
 * a bridge; it is a demonstration.
 *
 * So this contract settles against the **bonded attestation** that
 * `MolibraAnchor` already carries, and costs one ordinary transaction.
 *
 * ## ⛔⛔ What is trusted here, stated before anything else
 *
 *     trustless  - that this transaction is in the block with the anchored
 *                  hash, that the header really hashes to that hash, and that
 *                  it is released exactly once
 *     trusted    - that the anchored hash is the block Molibra's proof-of-work
 *                  actually produced at that height
 *
 * The second half is not a promise, it is a **bonded, slashable claim**. The
 * publisher has posted `minimumBond` and `proveEquivocation` takes their bond
 * if they ever sign two attestations for one height. And every anchor is
 * public and permanent, so a false one can be refuted by anybody running a
 * Molibra node.
 *
 * ⛔ That is strictly weaker than MolibraRelay and nobody should pretend
 * otherwise. It is the honest trade: the relay is trustless and unaffordable;
 * this is bonded and costs a transaction. Both are published, and a reader
 * picks. What is NOT acceptable is a bridge that claims the relay's security
 * while nobody can afford to run the relay.
 *
 * ## The instruction comes out of the proved transaction
 *
 * The recipient and the amount are decoded from the Molibra transaction
 * itself, never from the caller's arguments. A bridge that lets the submitter
 * name the recipient has made the proof decoration: anybody proves anybody's
 * transaction and names themselves.
 */

interface IMolibraAnchor {
    function anchors(uint256 height)
        external view returns (bytes32 blockHash, uint256 cumulativeWork, uint256 ethBlock, address publisher);
    function slashed(address publisher) external view returns (bool);
    function tipHeight() external view returns (uint256);
}

contract MolibraSettlement {
    IMolibraAnchor public immutable anchorContract;
    address public immutable owner;

    /**
     * ⛔ How long an anchor must have sat on Ethereum before it can pay out.
     *
     * This is the window in which an equivocating publisher can be slashed and
     * a false anchor can be shouted about. Zero would mean an anchor could be
     * posted and drained in the same block, which removes the only defence the
     * bond provides. Measured in ETHEREUM blocks, because that is the clock
     * this contract can actually read.
     */
    uint256 public challengeBlocks;

    /// keccak256("bridgeOut(address,uint256)")[0:4] — computed, never guessed.
    bytes4 public constant BRIDGE_OUT = 0x9854175f;

    mapping(bytes32 => bool) public released;

    event Released(bytes32 indexed molibraTx, address indexed to, uint256 amount, uint256 height);
    event Funded(address indexed from, uint256 amount);
    event ChallengeBlocksSet(uint256 value);

    error NotOwner();
    error AlreadyReleased();
    error NotAnchored(uint256 height);
    error PublisherSlashed();
    error ChallengeWindowOpen(uint256 anchoredAt, uint256 usableAt);
    error HeaderDoesNotMatchAnchor(bytes32 got, bytes32 want);
    error NotInBlock();
    error NotABridgeOut();
    error Insufficient();
    error BadProof();

    constructor(IMolibraAnchor anchor_, uint256 challengeBlocks_) payable {
        anchorContract = anchor_;
        owner = msg.sender;
        challengeBlocks = challengeBlocks_;
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    function setChallengeBlocks(uint256 value) external {
        if (msg.sender != owner) revert NotOwner();
        challengeBlocks = value;
        emit ChallengeBlocksSet(value);
    }

    function withdraw(uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, ) = payable(owner).call{ value: amount }("");
        if (!ok) revert Insufficient();
    }

    /* ------------------------------------------------------------ release */

    /**
     * Pay out one bridge-out.
     *
     * @param height    the Molibra height, which must be anchored
     * @param headerRlp the EXACT bytes Molibra hashes to get the block hash -
     *                  handed over rather than re-encoded here, so there are
     *                  not two encoders that must agree forever
     * @param rawTx     the Molibra transaction; its keccak is the Merkle leaf,
     *                  so proving inclusion and reading the instruction are one
     *                  act, with no gap between "this was on the chain" and
     *                  "this is what it said"
     */
    function release(
        uint256 height,
        bytes calldata headerRlp,
        bytes calldata rawTx,
        bytes32[] calldata siblings,
        bool[] calldata siblingOnRight
    ) external {
        bytes32 txHash = keccak256(rawTx);
        if (released[txHash]) revert AlreadyReleased();

        // Split out so the stack stays shallow: the anchor checks need four
        // locals that nothing below this line uses again.
        _requireUsableAnchor(height, keccak256(headerRlp));

        if (merkleRoot(txHash, siblings, siblingOnRight) != txRootOf(headerRlp)) revert NotInBlock();

        (address recipient, uint256 amount) = decodeBridgeOut(rawTx);
        if (amount == 0 || amount > address(this).balance) revert Insufficient();

        released[txHash] = true;
        (bool ok, ) = payable(recipient).call{ value: amount }("");
        if (!ok) revert Insufficient();
        emit Released(txHash, recipient, amount, height);
    }

    /**
     * The anchor half of `release`: is there a bonded, unslashed, matured
     * attestation for this height, and are these header bytes the ones it
     * committed to?
     *
     * ⛔ Ordering is the point. The header is checked against the anchor by its
     * own hash BEFORE anything parses it, so the parser downstream is only ever
     * fed bytes Molibra committed to and cannot be handed a hostile encoding.
     */
    function _requireUsableAnchor(uint256 height, bytes32 headerHash) private view {
        (bytes32 anchored, , uint256 ethBlock, address publisher) = anchorContract.anchors(height);
        if (anchored == bytes32(0)) revert NotAnchored(height);
        // ⛔ A publisher already caught equivocating pays out nothing, ever -
        // including on anchors they posted before they were caught. One proved
        // lie about any height is a reason to disbelieve all of them.
        if (anchorContract.slashed(publisher)) revert PublisherSlashed();
        unchecked {
            uint256 usableAt = ethBlock + challengeBlocks;
            if (block.number < usableAt) revert ChallengeWindowOpen(ethBlock, usableAt);
        }
        if (headerHash != anchored) revert HeaderDoesNotMatchAnchor(headerHash, anchored);
    }

    /* --------------------------------------------------------------- rlp */

    /**
     * Pull the txRoot out of a Molibra header.
     *
     * The header is `rlp([number, parentHash, timestamp, miner, stateRoot,
     * txRoot, difficulty, gasLimit, gasUsed, extraData, nonce])`, so txRoot is
     * item 5. Only the five items before it are skipped - nothing after is
     * parsed, because nothing after is needed and every branch not written is
     * a branch that cannot be wrong.
     *
     * ⛔ The header has ALREADY been checked against the anchor by hash before
     * this is called. That ordering matters: it means these bytes are the ones
     * Molibra committed to, so the parse cannot be fed a hostile encoding.
     */
    function txRootOf(bytes calldata headerRlp) public pure returns (bytes32 root) {
        uint256 i = _listPayloadStart(headerRlp);
        for (uint256 item = 0; item < 5; item++) {
            i = _skipItem(headerRlp, i);
        }
        // Item 5 must be a 32-byte string: 0xa0 followed by the 32 bytes.
        if (headerRlp[i] != 0xa0) revert BadProof();
        return bytes32(headerRlp[i + 1:i + 33]);
    }

    /// Where a list's payload begins, refusing anything that is not a list.
    function _listPayloadStart(bytes calldata b) private pure returns (uint256) {
        uint8 prefix = uint8(b[0]);
        if (prefix >= 0xc0 && prefix <= 0xf7) return 1;
        if (prefix >= 0xf8) return 1 + (prefix - 0xf7);
        revert BadProof();
    }

    /// The index just past the item starting at `i`.
    function _skipItem(bytes calldata b, uint256 i) private pure returns (uint256) {
        uint8 prefix = uint8(b[i]);
        if (prefix <= 0x7f) return i + 1;                       // single byte
        if (prefix <= 0xb7) return i + 1 + (prefix - 0x80);     // short string
        if (prefix <= 0xbf) {                                   // long string
            uint256 lenOfLen = prefix - 0xb7;
            return i + 1 + lenOfLen + _readLength(b, i + 1, lenOfLen);
        }
        if (prefix <= 0xf7) return i + 1 + (prefix - 0xc0);     // short list
        uint256 lol = prefix - 0xf7;                            // long list
        return i + 1 + lol + _readLength(b, i + 1, lol);
    }

    function _readLength(bytes calldata b, uint256 at, uint256 n) private pure returns (uint256 len) {
        if (n == 0 || n > 8) revert BadProof();
        for (uint256 k = 0; k < n; k++) len = (len << 8) | uint8(b[at + k]);
    }

    /* ------------------------------------------------------------ merkle */

    /**
     * The Merkle root implied by a leaf and its path.
     *
     * ⛔ `siblingOnRight` is supplied per level rather than derived from an
     * index, and it is what makes the path unambiguous. A verifier that always
     * hashes in one order accepts a proof for a different position in the tree.
     */
    function merkleRoot(bytes32 leaf, bytes32[] calldata siblings, bool[] calldata siblingOnRight)
        public pure returns (bytes32 node)
    {
        if (siblings.length != siblingOnRight.length) revert BadProof();
        node = leaf;
        for (uint256 i = 0; i < siblings.length; i++) {
            node = siblingOnRight[i]
                ? keccak256(abi.encodePacked(node, siblings[i]))
                : keccak256(abi.encodePacked(siblings[i], node));
        }
    }

    /* ------------------------------------------------------------ decode */

    /**
     * Read the instruction out of the Molibra transaction.
     *
     * A Molibra transaction is `rlp([nonce, gasPrice, gasLimit, to, value,
     * data, v, r, s])` and the bridge-out lives in `data` as
     * `BRIDGE_OUT ‖ recipient(20) ‖ amount(32)`. The signature is inside the
     * bytes whose hash was just proved, so the instruction is the signer's,
     * not the submitter's.
     */
    function decodeBridgeOut(bytes calldata rawTx) public pure returns (address to, uint256 amount) {
        uint256 i = _listPayloadStart(rawTx);
        for (uint256 item = 0; item < 5; item++) {
            i = _skipItem(rawTx, i);           // nonce, gasPrice, gasLimit, to, value
        }
        // `data` must be a string of exactly 4 + 20 + 32 = 56 bytes.
        uint8 prefix = uint8(rawTx[i]);
        uint256 start;
        uint256 len;
        if (prefix > 0x80 && prefix <= 0xb7) {
            len = prefix - 0x80;
            start = i + 1;
        } else if (prefix > 0xb7 && prefix <= 0xbf) {
            uint256 lenOfLen = prefix - 0xb7;
            len = _readLength(rawTx, i + 1, lenOfLen);
            start = i + 1 + lenOfLen;
        } else {
            revert NotABridgeOut();
        }
        if (len != 56) revert NotABridgeOut();
        if (bytes4(rawTx[start:start + 4]) != BRIDGE_OUT) revert NotABridgeOut();

        to = address(bytes20(rawTx[start + 4:start + 24]));
        amount = uint256(bytes32(rawTx[start + 24:start + 56]));
    }

    /** What a reader should be able to see without an archive node. */
    function status(uint256 height)
        external view returns (bool anchored, bool usable, uint256 anchoredAtEthBlock, uint256 funds)
    {
        (bytes32 h, , uint256 ethBlock, address publisher) = anchorContract.anchors(height);
        anchored = h != bytes32(0);
        usable = anchored
            && !anchorContract.slashed(publisher)
            && block.number >= ethBlock + challengeBlocks;
        anchoredAtEthBlock = ethBlock;
        funds = address(this).balance;
    }
}
