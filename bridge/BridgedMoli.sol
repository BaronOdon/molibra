// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * BridgedMoli — MOLI on Ethereum, minted only against MOLI destroyed on Molibra.
 *
 * ## ⛔⛔ What backs a unit, stated before anything else
 *
 * Every bMOLI here exists because that much MOLI was DESTROYED on Molibra by a
 * transaction in a block whose hash is anchored on this chain. Not locked in a
 * vault, not held by the operator, not held by a multisig — destroyed. There is
 * no custodian to rob, because there is nothing being held.
 *
 * ⛔ This deliberately does NOT mint against `bridgeOut`. A bridge-out on
 * Molibra moves nothing; it is a statement the signer made, and
 * `MolibraSettlement` pays ETH against it out of a pot the operator funded and
 * can withdraw — bounded, underwritten, sound. A MINT has no such bound. A
 * signer whose MOLI still existed could sign another bridge-out at the next
 * nonce, producing a different hash, a different leaf, and another claimable
 * mint, forever. So this contract reads `moliBurn(address,uint256)`, a payload
 * Molibra's consensus honours by taking the coin out of existence, and it will
 * not accept a bridge-out at all. Every bridge-out ever signed — including the
 * ones already anchored — is unreachable from here by construction.
 *
 * ## ⛔⛔ What is trusted, in the same words MolibraSettlement uses
 *
 *     trustless  - that this transaction is in the block with the anchored
 *                  hash, that the header really hashes to that hash, that it
 *                  destroyed that much MOLI, and that it is minted exactly once
 *     trusted    - that the anchored hash is the block Molibra's proof-of-work
 *                  actually produced at that height
 *
 * The second half is a bonded, slashable claim, not a promise: the publisher
 * has posted `minimumBond` to `MolibraAnchor` and `proveEquivocation` takes it
 * if they ever sign two attestations for one height. ⛔ Backing is the BONDED
 * ANCHOR, not verified proof-of-work. That is strictly weaker than
 * `MolibraRelay`, which verifies the work itself and costs 168,288 gas per
 * header — trustless and unaffordable. Nobody should describe this token as
 * secured by Molibra's proof-of-work. It is secured by a bond and by the fact
 * that every anchor is public, permanent, and refutable by anyone running a
 * node.
 *
 * ## ⛔⛔ Crossing is ONE-WAY
 *
 * Burning MOLI on Molibra mints bMOLI here. There is no path back: returning
 * would need a proved burn of this ERC-20 honoured on Molibra by releasing
 * MOLI, and that instruction does not exist. Until it does, this must be
 * labelled one-way everywhere a person can reach it — the same honesty the
 * WSRO leg needed, for the same reason.
 */

interface IMolibraAnchor {
    function anchors(uint256 height)
        external view returns (bytes32 blockHash, uint256 cumulativeWork, uint256 ethBlock, address publisher);
    function slashed(address publisher) external view returns (bool);
}

contract BridgedMoli {
    /* ------------------------------------------------------------- erc20 */

    string public constant name = "Bridged MOLI";
    string public constant symbol = "bMOLI";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /* -------------------------------------------------------------- proof */

    IMolibraAnchor public immutable anchorContract;

    /**
     * ⛔ How long an anchor must sit on Ethereum before it can mint.
     *
     * The window in which an equivocating publisher can be slashed and a false
     * anchor shouted about. Zero would let an anchor be posted and minted
     * against in the same block, removing the only defence the bond provides.
     *
     * ⛔ Immutable here, unlike MolibraSettlement's settable one. A settable
     * window on a MINT is an owner switch that turns the bond off: set it to
     * zero, post an anchor, mint against it in the same block. The settlement
     * contract can afford that switch because its loss is capped by its own
     * balance. This one cannot.
     */
    uint256 public immutable challengeBlocks;

    /// keccak256("moliBurn(address,uint256)")[0:4] — computed, never guessed.
    bytes4 public constant MOLI_BURN = 0x94a06c3e;

    /**
     * ⛔ Refused explicitly rather than merely not matched.
     *
     * keccak256("bridgeOut(address,uint256)")[0:4]. A bridge-out has the same
     * 56-byte shape as a burn and differs only in these four bytes, so the
     * failure mode of confusing them is minting against MOLI that still
     * exists. `NotAMoliBurn` would already refuse it; this names it, so the
     * revert says why instead of leaving the next reader to work it out.
     */
    bytes4 public constant BRIDGE_OUT = 0x9854175f;

    /// Molibra transactions already minted, so a proof spends exactly once.
    mapping(bytes32 => bool) public claimed;

    event Claimed(bytes32 indexed molibraTx, address indexed to, uint256 amount, uint256 height);

    error AlreadyClaimed();
    error NotAnchored(uint256 height);
    error PublisherSlashed();
    error ChallengeWindowOpen(uint256 anchoredAt, uint256 usableAt);
    error HeaderDoesNotMatchAnchor(bytes32 got, bytes32 want);
    error NotInBlock();
    error NotAMoliBurn();
    error ABridgeOutBurnsNothing();
    error ZeroAmount();
    error BadProof();

    constructor(IMolibraAnchor anchor_, uint256 challengeBlocks_) {
        anchorContract = anchor_;
        challengeBlocks = challengeBlocks_;
    }

    /* -------------------------------------------------------------- claim */

    /**
     * Mint the bMOLI for one destroyed lot of MOLI.
     *
     * ⛔ There is no owner, no pause, no mint path but this one, and no way to
     * change the anchor or the window after construction. A token whose issuer
     * can mint at will is not backed by anything a reader can check, whatever
     * its documentation says.
     *
     * @param height    the Molibra height, which must be anchored
     * @param headerRlp the EXACT bytes Molibra hashes to get the block hash —
     *                  handed over rather than re-encoded here, so there are
     *                  not two encoders that must agree forever
     * @param rawTx     the Molibra transaction; its keccak is the Merkle leaf,
     *                  so proving inclusion and reading the instruction are one
     *                  act, with no gap between "this was on the chain" and
     *                  "this is what it said"
     */
    function claim(
        uint256 height,
        bytes calldata headerRlp,
        bytes calldata rawTx,
        bytes32[] calldata siblings,
        bool[] calldata siblingOnRight
    ) external {
        bytes32 txHash = keccak256(rawTx);
        if (claimed[txHash]) revert AlreadyClaimed();

        _requireUsableAnchor(height, keccak256(headerRlp));

        if (merkleRoot(txHash, siblings, siblingOnRight) != txRootOf(headerRlp)) revert NotInBlock();

        (address recipient, uint256 amount) = decodeMoliBurn(rawTx);
        if (amount == 0) revert ZeroAmount();

        claimed[txHash] = true;

        // ⛔ The recipient comes out of the PROVED transaction, never from the
        // caller's arguments. A bridge that lets the submitter name the
        // recipient has made the proof decoration: anybody proves anybody's
        // burn and names themselves.
        totalSupply += amount;
        unchecked { balanceOf[recipient] += amount; }
        emit Transfer(address(0), recipient, amount);
        emit Claimed(txHash, recipient, amount, height);
    }

    /**
     * ⛔ Ordering is the point. The header is checked against the anchor by its
     * own hash BEFORE anything parses it, so the parser downstream is only ever
     * fed bytes Molibra committed to and cannot be handed a hostile encoding.
     */
    function _requireUsableAnchor(uint256 height, bytes32 headerHash) private view {
        (bytes32 anchored, , uint256 ethBlock, address publisher) = anchorContract.anchors(height);
        if (anchored == bytes32(0)) revert NotAnchored(height);
        // ⛔ A publisher already caught equivocating mints nothing, ever —
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
     * Pull the txRoot out of a Molibra header: item 5 of
     * `rlp([number, parentHash, timestamp, miner, stateRoot, txRoot, ...])`.
     * Nothing after it is parsed, because nothing after it is needed and every
     * branch not written is a branch that cannot be wrong.
     */
    function txRootOf(bytes calldata headerRlp) public pure returns (bytes32) {
        uint256 i = _listPayloadStart(headerRlp);
        for (uint256 item = 0; item < 5; item++) {
            i = _skipItem(headerRlp, i);
        }
        if (headerRlp[i] != 0xa0) revert BadProof();
        return bytes32(headerRlp[i + 1:i + 33]);
    }

    function _listPayloadStart(bytes calldata b) private pure returns (uint256) {
        uint8 prefix = uint8(b[0]);
        if (prefix >= 0xc0 && prefix <= 0xf7) return 1;
        if (prefix >= 0xf8) return 1 + (prefix - 0xf7);
        revert BadProof();
    }

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
     * data, v, r, s])` and the burn lives in `data` as
     * `MOLI_BURN ‖ recipient(20) ‖ amount(32)`. The signature is inside the
     * bytes whose hash was just proved, so the instruction is the signer's,
     * not the submitter's.
     */
    function decodeMoliBurn(bytes calldata rawTx) public pure returns (address to, uint256 amount) {
        uint256 i = _listPayloadStart(rawTx);
        for (uint256 item = 0; item < 5; item++) {
            i = _skipItem(rawTx, i);           // nonce, gasPrice, gasLimit, to, value
        }
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
            revert NotAMoliBurn();
        }
        if (len != 56) revert NotAMoliBurn();

        bytes4 selector = bytes4(rawTx[start:start + 4]);
        // Named explicitly: the shapes are identical and only these four bytes
        // separate "MOLI was destroyed" from "somebody said something".
        if (selector == BRIDGE_OUT) revert ABridgeOutBurnsNothing();
        if (selector != MOLI_BURN) revert NotAMoliBurn();

        to = address(bytes20(rawTx[start + 4:start + 24]));
        amount = uint256(bytes32(rawTx[start + 24:start + 56]));
    }

    /* ------------------------------------------------------------- erc20 */

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "to zero");
        uint256 held = balanceOf[from];
        require(held >= value, "balance");
        unchecked {
            balanceOf[from] = held - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    /** What a reader should be able to see without an archive node. */
    function status(uint256 height)
        external view returns (bool anchored, bool usable, uint256 anchoredAtEthBlock, uint256 supply)
    {
        (bytes32 h, , uint256 ethBlock, address publisher) = anchorContract.anchors(height);
        anchored = h != bytes32(0);
        usable = anchored
            && !anchorContract.slashed(publisher)
            && block.number >= ethBlock + challengeBlocks;
        anchoredAtEthBlock = ethBlock;
        supply = totalSupply;
    }
}
