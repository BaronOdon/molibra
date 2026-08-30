// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MolibraProver — verifies, on Ethereum, that a transaction happened on Molibra.
 *
 * Molibra uses the same primitives Ethereum does (Keccak-256, RLP, an
 * EIP-155 transaction), which is what makes this possible in a few hundred
 * lines: the EVM already has the one hash function the whole proof needs.
 *
 * Given a Molibra block header and a Merkle path, this contract establishes
 * for itself, trusting nobody who passed it along:
 *
 *   1. the header hashes to the block hash it claims;
 *   2. the header satisfies its own stated difficulty - real work was spent;
 *   3. the transaction is in that block's transaction root.
 *
 * ⛔⛔ WHAT THIS DOES NOT ESTABLISH, AND WHY THAT MATTERS FOR MONEY
 *
 * It does NOT prove the block is on Molibra's canonical chain. A single header
 * with valid proof of work is exactly as convincing as the work in it - and
 * Molibra's difficulty is small, so a header that passes this check is
 * cheap to manufacture. Anyone can mine a private block that satisfies the
 * seal and hand you a perfectly valid proof of a transaction that no honest
 * node ever accepted.
 *
 * A production bridge therefore CANNOT rely on this alone. It needs a header
 * chain with accumulated difficulty and a confirmation depth, so that forging
 * a proof means out-working the network rather than out-working one block.
 * `MolibraTestBridge` below is a TEST RIG and says so; it is not a bridge you
 * should put other people's money behind.
 */
library MolibraRLP {
    /**
     * `start` is where the item's ENCODING begins; `offset` where its PAYLOAD
     * does. They differ by the prefix, which is 0 bytes for a single byte
     * below 0x80 and 1 or more otherwise - and that difference is exactly what
     * a "subtract one for the prefix" shortcut gets wrong for small values.
     */
    struct Item { uint256 start; uint256 offset; uint256 length; }

    /** Split a canonical RLP list into its items, as slices of `data`. */
    function items(bytes memory data, uint256 max)
        internal pure returns (Item[] memory out, uint256 count, uint256 payloadStart)
    {
        require(data.length > 0, "empty rlp");
        uint256 prefix = uint8(data[0]);
        uint256 cursor;
        if (prefix >= 0xf8) {
            uint256 lenOfLen = prefix - 0xf7;
            cursor = 1 + lenOfLen;
        } else {
            require(prefix >= 0xc0, "not an rlp list");
            cursor = 1;
        }
        payloadStart = cursor;

        out = new Item[](max);
        while (cursor < data.length) {
            require(count < max, "too many rlp items");
            uint256 b = uint8(data[cursor]);
            uint256 start = cursor;
            uint256 offset;
            uint256 length;
            if (b <= 0x7f) {
                offset = cursor; length = 1; cursor += 1;
            } else if (b <= 0xb7) {
                offset = cursor + 1; length = b - 0x80; cursor += 1 + length;
            } else if (b <= 0xbf) {
                uint256 lenOfLen = b - 0xb7;
                length = 0;
                for (uint256 i = 0; i < lenOfLen; i++) {
                    length = (length << 8) | uint8(data[cursor + 1 + i]);
                }
                offset = cursor + 1 + lenOfLen; cursor = offset + length;
            } else {
                revert("nested rlp lists are not expected in a header");
            }
            require(cursor <= data.length, "rlp overruns");
            out[count] = Item(start, offset, length);
            count += 1;
        }
    }

    /** Read an item as a big-endian unsigned integer. */
    function toUint(bytes memory data, Item memory item) internal pure returns (uint256 value) {
        require(item.length <= 32, "integer too wide");
        for (uint256 i = 0; i < item.length; i++) {
            value = (value << 8) | uint8(data[item.offset + i]);
        }
    }

    /** Read a 32-byte item as bytes32. */
    function toBytes32(bytes memory data, Item memory item) internal pure returns (bytes32 out) {
        require(item.length == 32, "expected 32 bytes");
        uint256 offset = item.offset;
        assembly { out := mload(add(add(data, 0x20), offset)) }
    }

    /** Copy a slice out. */
    function slice(bytes memory data, uint256 offset, uint256 length)
        internal pure returns (bytes memory out)
    {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) out[i] = data[offset + i];
    }

    /** The RLP list prefix for a payload of `length` bytes. */
    function listPrefix(uint256 length) internal pure returns (bytes memory) {
        if (length < 56) return abi.encodePacked(uint8(0xc0 + length));
        uint256 lenOfLen;
        uint256 tmp = length;
        while (tmp != 0) { lenOfLen += 1; tmp >>= 8; }
        bytes memory encoded = new bytes(lenOfLen);
        tmp = length;
        for (uint256 i = lenOfLen; i > 0; i--) {
            encoded[i - 1] = bytes1(uint8(tmp & 0xff));
            tmp >>= 8;
        }
        return abi.encodePacked(uint8(0xf7 + lenOfLen), encoded);
    }
}

contract MolibraProver {
    using MolibraRLP for bytes;

    /// Header item order, fixed by src/block.js headerItems().
    uint256 private constant I_TX_ROOT = 5;
    uint256 private constant I_DIFFICULTY = 6;
    uint256 private constant I_NONCE = 10;
    uint256 private constant HEADER_ITEMS = 11;

    struct Header {
        bytes32 blockHash;
        bytes32 txRoot;
        uint256 number;
        uint256 difficulty;
    }

    /**
     * Re-derive everything from the header bytes. Nothing is taken on trust:
     * the block hash comes from hashing the header, and the seal is checked
     * against the difficulty the header itself declares.
     */
    function verifyHeader(bytes memory headerRlp) public pure returns (Header memory header) {
        (MolibraRLP.Item[] memory items, uint256 count, uint256 payloadStart) =
            headerRlp.items(HEADER_ITEMS);
        require(count == HEADER_ITEMS, "a molibra header has 11 items");

        header.blockHash = keccak256(headerRlp);
        header.txRoot = MolibraRLP.toBytes32(headerRlp, items[I_TX_ROOT]);
        header.number = MolibraRLP.toUint(headerRlp, items[0]);
        header.difficulty = MolibraRLP.toUint(headerRlp, items[I_DIFFICULTY]);
        require(header.difficulty > 0, "difficulty must be positive");

        // The seal is ground against the header WITHOUT its nonce. That is the
        // same list minus its last item, so the payload is a prefix of this
        // one and only the list header changes - no re-encoding of the items
        // themselves, which is what would let a forger slip a different value
        // past the check.
        uint256 sealPayloadLength = items[I_NONCE].start - payloadStart;
        bytes32 sealDigest = keccak256(abi.encodePacked(
            MolibraRLP.listPrefix(sealPayloadLength),
            MolibraRLP.slice(headerRlp, payloadStart, sealPayloadLength)
        ));

        bytes memory nonceBytes =
            MolibraRLP.slice(headerRlp, items[I_NONCE].offset, items[I_NONCE].length);
        uint256 sealHash = uint256(keccak256(abi.encodePacked(sealDigest, nonceBytes)));

        require(sealHash < targetFor(header.difficulty), "proof of work does not satisfy difficulty");
    }

    /**
     * Diagnostics. Kept rather than deleted after the bug they found: when a
     * verifier rejects a proof, "invalid" is not an answer anybody can act on,
     * and being able to ask the contract what it parsed is the difference
     * between a fix and a guess.
     */
    function parse(bytes memory headerRlp) public pure returns (
        uint256 count, uint256 payloadStart, uint256 nonceStart,
        uint256 difficulty, bytes32 txRoot
    ) {
        MolibraRLP.Item[] memory items;
        (items, count, payloadStart) = headerRlp.items(HEADER_ITEMS);
        if (count == HEADER_ITEMS) {
            nonceStart = items[I_NONCE].start;
            difficulty = MolibraRLP.toUint(headerRlp, items[I_DIFFICULTY]);
            txRoot = MolibraRLP.toBytes32(headerRlp, items[I_TX_ROOT]);
        }
    }

    function sealOf(bytes memory headerRlp)
        public pure returns (bytes32 sealDigest, uint256 sealHash, uint256 target)
    {
        (MolibraRLP.Item[] memory items, uint256 count, uint256 payloadStart) =
            headerRlp.items(HEADER_ITEMS);
        require(count == HEADER_ITEMS, "a molibra header has 11 items");
        uint256 sealPayloadLength = items[I_NONCE].start - payloadStart;
        sealDigest = keccak256(abi.encodePacked(
            MolibraRLP.listPrefix(sealPayloadLength),
            MolibraRLP.slice(headerRlp, payloadStart, sealPayloadLength)
        ));
        sealHash = uint256(keccak256(abi.encodePacked(
            sealDigest,
            MolibraRLP.slice(headerRlp, items[I_NONCE].offset, items[I_NONCE].length)
        )));
        target = targetFor(MolibraRLP.toUint(headerRlp, items[I_DIFFICULTY]));
    }

    /**
     * floor(2^256 / difficulty), computed exactly.
     *
     * 2^256 does not fit, so it is reconstructed from the division of
     * (2^256 - 1): the two agree except when the remainder is difficulty-1,
     * which is precisely when difficulty divides 2^256. Getting this wrong by
     * one would reject a small number of perfectly valid blocks, and the bug
     * would show up months later as "the bridge sometimes doesn't work".
     */
    function targetFor(uint256 difficulty) public pure returns (uint256 target) {
        target = type(uint256).max / difficulty;
        if (type(uint256).max % difficulty == difficulty - 1) target += 1;
    }

    /**
     * Fold a Merkle path back to a root.
     *
     * Molibra PROMOTES an odd trailing node rather than duplicating it, so a
     * level with no sibling contributes no step at all. That is why the path
     * is a list of actual combining steps and not one entry per level: a
     * verifier written to the duplicate convention would reject every block
     * with an odd transaction count.
     */
    function merkleRoot(bytes32 leaf, bytes32[] memory siblings, bool[] memory siblingOnRight)
        public pure returns (bytes32 node)
    {
        require(siblings.length == siblingOnRight.length, "path shape mismatch");
        node = leaf;
        for (uint256 i = 0; i < siblings.length; i++) {
            node = siblingOnRight[i]
                ? keccak256(abi.encodePacked(node, siblings[i]))
                : keccak256(abi.encodePacked(siblings[i], node));
        }
    }

    /**
     * The whole check. Returns the block it was proved against, so a caller
     * can apply its own policy - a minimum difficulty, a confirmation depth,
     * a known-good header set - rather than treating "verified" as "safe".
     */
    function verifyTransaction(
        bytes memory headerRlp,
        bytes32 txHash,
        bytes32[] memory siblings,
        bool[] memory siblingOnRight
    ) public pure returns (Header memory header) {
        header = verifyHeader(headerRlp);
        require(
            merkleRoot(txHash, siblings, siblingOnRight) == header.txRoot,
            "transaction is not in this block"
        );
    }
}

/**
 * MolibraTestBridge — a TEST RIG, and nothing more.
 *
 * ⛔⛔ DO NOT PUT OTHER PEOPLE'S MONEY IN THIS. It releases ETH against a
 * single Molibra header with valid proof of work, and Molibra's difficulty is
 * small enough that such a header can be mined privately in seconds. Anyone
 * who can do that can drain the balance. It exists so an operator can prove
 * the verification path works end to end with their own funds, on their own
 * network, before anybody designs the real thing.
 *
 * What the real thing needs, and this deliberately does not have: a header
 * chain with accumulated difficulty, a confirmation depth, a difficulty floor
 * that tracks the live network, and - before a single line of it is written -
 * the written legal opinions recorded in the project's compliance file, because
 * releasing value on behalf of third parties is a regulated activity.
 */
contract MolibraTestBridge {
    MolibraProver public immutable prover;
    address public immutable owner;
    uint256 public minDifficulty;

    /// One release per Molibra transaction, ever.
    mapping(bytes32 => bool) public claimed;

    event Funded(address indexed from, uint256 amount);
    event Released(bytes32 indexed molibraTx, address indexed to, uint256 amount, uint256 blockNumber);

    error NotOwner();
    error AlreadyClaimed();
    error DifficultyTooLow(uint256 got, uint256 required);
    error NothingToSend();

    constructor(MolibraProver prover_, uint256 minDifficulty_) payable {
        prover = prover_;
        owner = msg.sender;
        minDifficulty = minDifficulty_;
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    receive() external payable { emit Funded(msg.sender, msg.value); }

    function setMinDifficulty(uint256 value) external {
        if (msg.sender != owner) revert NotOwner();
        minDifficulty = value;
    }

    /** The operator can always take their test funds back. */
    function withdraw() external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, ) = owner.call{ value: address(this).balance }("");
        require(ok, "withdraw failed");
    }

    /**
     * Prove a Molibra transaction and release `amount` to `recipient`.
     *
     * The recipient and amount are arguments rather than being read out of the
     * Molibra transaction, because decoding an EIP-155 transaction on-chain is
     * a second thing to get wrong and this is a test rig. In a real bridge the
     * instruction must come FROM the proved transaction, or the proof is
     * decoration - somebody proves any Molibra transaction and names
     * themselves.
     */
    function release(
        bytes calldata headerRlp,
        bytes32 molibraTx,
        bytes32[] calldata siblings,
        bool[] calldata siblingOnRight,
        address payable recipient,
        uint256 amount
    ) external {
        if (claimed[molibraTx]) revert AlreadyClaimed();

        MolibraProver.Header memory header =
            prover.verifyTransaction(headerRlp, molibraTx, siblings, siblingOnRight);
        if (header.difficulty < minDifficulty) {
            revert DifficultyTooLow(header.difficulty, minDifficulty);
        }
        if (amount == 0 || amount > address(this).balance) revert NothingToSend();

        claimed[molibraTx] = true;
        (bool ok, ) = recipient.call{ value: amount }("");
        require(ok, "transfer failed");
        emit Released(molibraTx, recipient, amount, header.number);
    }
}
