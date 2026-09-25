// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/**
 * DocumentRegistry - proves on Molibra that a document existed, and that named
 * wallets agreed to it, WITHOUT publishing the document.
 *
 * ⛔ Only the SHA-256 of the file is recorded. A signed document carries names
 *    and signatures; a public chain can never erase anything, and personal data
 *    must stay deletable. The hash proves the file without revealing it: anyone
 *    holding the file recomputes the hash and finds it here, with who registered
 *    it, who co-signed it, and when.
 *
 * Every record is numbered from 1 in the order it was registered, so "the first
 * document ever registered" is a value on the chain (hashAt(1)), not a claim.
 *
 * Flow for a co-signed consent form:
 *   1. register(sha256(signedPdf), "Consent form", [cosigner, registrant])
 *   2. each named signer calls sign(hash) from their own wallet
 *   3. a signer may later call revoke(hash): the record stays, marked revoked
 *      (LGPD art. 8 §5 - consent is revocable; history is not rewritten)
 *
 * No owner, no admin, no upgrade, no fee beyond gas (paid in MOLI).
 */
contract DocumentRegistry {
    struct Document {
        address registrant;
        uint64 registeredAt;
        uint64 revokedAt;      // 0 = not revoked
        address revokedBy;
        string label;          // human-readable; NEVER personal data
        address[] signers;     // who is asked to sign
    }

    mapping(bytes32 => Document) private docs;
    mapping(bytes32 => mapping(address => uint64)) public signedAt;   // 0 = not signed

    uint256 public count;                          // records registered so far
    mapping(bytes32 => uint256) public numberOf;   // 1-based; 0 = not registered
    mapping(uint256 => bytes32) public hashAt;     // number => hash

    event Registered(bytes32 indexed hash, uint256 indexed number, address indexed registrant,
                     string label, address[] signers);
    event Signed(bytes32 indexed hash, address indexed signer);
    event Revoked(bytes32 indexed hash, address indexed by);

    error AlreadyRegistered();
    error NotRegistered();
    error NotASigner();
    error AlreadySigned();
    error AlreadyRevoked();
    error EmptyHash();

    function register(bytes32 hash, string calldata label, address[] calldata signers) external {
        if (hash == bytes32(0)) revert EmptyHash();
        // Existence is the record number, never a timestamp: a clock reading 0
        // would otherwise make every record look unregistered, and re-registrable.
        if (numberOf[hash] != 0) revert AlreadyRegistered();
        Document storage d = docs[hash];
        d.registrant = msg.sender;
        d.registeredAt = uint64(block.timestamp);
        d.label = label;
        d.signers = signers;
        uint256 n = ++count;
        numberOf[hash] = n;
        hashAt[n] = hash;
        emit Registered(hash, n, msg.sender, label, signers);
    }

    function sign(bytes32 hash) external {
        Document storage d = docs[hash];
        if (numberOf[hash] == 0) revert NotRegistered();
        if (d.revokedAt != 0) revert AlreadyRevoked();
        if (!_isSigner(d, msg.sender)) revert NotASigner();
        if (signedAt[hash][msg.sender] != 0) revert AlreadySigned();
        signedAt[hash][msg.sender] = uint64(block.timestamp);
        emit Signed(hash, msg.sender);
    }

    /// Any named signer may revoke. The record is kept, marked revoked.
    function revoke(bytes32 hash) external {
        Document storage d = docs[hash];
        if (numberOf[hash] == 0) revert NotRegistered();
        if (d.revokedAt != 0) revert AlreadyRevoked();
        if (!_isSigner(d, msg.sender)) revert NotASigner();
        d.revokedAt = uint64(block.timestamp);
        d.revokedBy = msg.sender;
        emit Revoked(hash, msg.sender);
    }

    /// Everything a reader needs to check a file against this registry.
    function status(bytes32 hash) external view returns (
        address registrant, uint64 registeredAt, string memory label,
        address[] memory signers, uint64[] memory signedTimes,
        bool fullySigned, uint64 revokedAt, address revokedBy
    ) {
        Document storage d = docs[hash];
        signedTimes = new uint64[](d.signers.length);
        fullySigned = d.signers.length > 0;
        for (uint256 i = 0; i < d.signers.length; i++) {
            signedTimes[i] = signedAt[hash][d.signers[i]];
            if (signedTimes[i] == 0) fullySigned = false;
        }
        return (d.registrant, d.registeredAt, d.label, d.signers, signedTimes,
                fullySigned, d.revokedAt, d.revokedBy);
    }

    function _isSigner(Document storage d, address who) private view returns (bool) {
        for (uint256 i = 0; i < d.signers.length; i++) if (d.signers[i] == who) return true;
        return false;
    }
}
