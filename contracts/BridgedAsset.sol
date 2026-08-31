// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * BridgedAsset - the ERC-20 face of an asset that crossed a bridge.
 *
 * Deliberately boring: transfer, approve, transferFrom, mint, burn. Nothing
 * else, because everything else is somewhere it can be audited.
 *
 * ⛔ `mint` is restricted to the bridge address and nothing else can call it.
 * The supply of this token is not a policy decision made here; it is the
 * arithmetic consequence of proved burns on the origin chain, enforced by
 * src/inbound.js, whose invariant is
 *
 *     minted here == sum(proved burns there) - sum(returns)
 *
 * A mint function anyone could call would make that invariant a comment.
 *
 * ⛔⛔ AND SO WOULD A BRIDGE ADDRESS SOMEBODY HOLDS THE KEY FOR. Restricting
 * `mint` to an address is only worth as much as the address. The `bridge_`
 * this is deployed with must be the value `bridgeAuthority(tokenId)` returns
 * in src/bridgemint.js:
 *
 *     last20( keccak256("molibra:bridge-authority:v1" || tokenId) )
 *
 * That is the image of a hash, not of a public key, so no signature recovers
 * to it and no transaction can be sent from it. The only way anything executes
 * with that `msg.sender` is Molibra's consensus path, which verifies a Merkle
 * proof of the origin burn first. Consensus REFUSES to register an asset whose
 * contract trusts anything else, so a contract deployed with an ordinary
 * wallet here is not a bridged asset - it is a token somebody can print.
 *
 * ⚠ `burn` is public, and on Molibra it is reached through a BRIDGE_RELEASE
 * transaction rather than called directly - consensus refuses a direct call so
 * that the ledger is told what was destroyed. See src/bridgemint.js.
 *
 * ⛔ This is NOT a Molibra registry token. It cannot be used for an expression
 * of will, it has no vote mode and no expression cost, and no contract can
 * make it into one - registry tokens are consensus records, not contracts.
 * An asset that crossed a bridge is an asset; a question is opened here, by
 * somebody who signed for it here.
 */
contract BridgedAsset {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// The only address that may mint. Set once, at construction.
    address public immutable bridge;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotBridge();
    error Insufficient();

    constructor(string memory name_, string memory symbol_, address bridge_) {
        name = name_;
        symbol = symbol_;
        bridge = bridge_;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An unlimited allowance is left untouched rather than decremented, so
        // it does not cost storage on every transfer.
        if (allowed != type(uint256).max) {
            if (allowed < value) revert Insufficient();
            allowance[from][msg.sender] = allowed - value;
        }
        return _move(from, to, value);
    }

    /** Only the bridge, and only against a burn it has already proved. */
    function mint(address to, uint256 value) external {
        if (msg.sender != bridge) revert NotBridge();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    /** Anybody may destroy their own units - the return leg of the bridge. */
    function burn(uint256 value) external {
        if (balanceOf[msg.sender] < value) revert Insufficient();
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function _move(address from, address to, uint256 value) private returns (bool) {
        if (balanceOf[from] < value) revert Insufficient();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
