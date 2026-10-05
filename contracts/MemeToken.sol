// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MemeToken - a plain, fixed-supply ERC-20 for Molibra's EVM side.
 *
 * One contract, deployed once per coin with its own name, symbol, supply and
 * description. Everything that could change what a holder owns after the fact
 * is absent BY CONSTRUCTION, not switched off:
 *
 *   - no owner, no admin, no roles      -> nobody can call anything privileged
 *   - no mint after the constructor     -> the supply can only ever go DOWN
 *   - no burn-from, no pause, no blacklist, no fee-on-transfer, no upgrade proxy
 *
 * The whole supply is minted once, to `holder`, in the constructor.
 *
 * `burn(amount)` destroys the CALLER's own units and nobody else's, and emits
 * Transfer(caller, 0x0, amount). That log is exactly what Molibra's inbound
 * bridge proves (src/burnproof.js `findBurn`: a Transfer to the zero address,
 * emitted by the registered contract), so an Ethereum deployment of this
 * contract can be brought onto Molibra 1:1 the same way WSRO is.
 *
 * `description` is stored on-chain so every wallet and explorer that asks the
 * contract reads the same disclaimer the deployer wrote - a meme, unofficial,
 * not affiliated with or endorsed by anybody it is named after, no promise of
 * value. It is immutable like everything else here.
 *
 * ⛔ This is an ordinary EVM contract, so a MolibraPool can make a market in it.
 * It is NOT a consensus-registry token (GIZ and every expression token live
 * there, have no bytecode and can never be pooled). Nothing here touches that
 * registry and nothing can.
 *
 * No external imports: the file is read in full by anybody who wants to know
 * what they hold.
 */
contract MemeToken {
    string public name;
    string public symbol;
    string public description;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    /// @param supply whole supply in base units (18 decimals), all to `holder`.
    constructor(
        string memory name_,
        string memory symbol_,
        string memory description_,
        uint256 supply,
        address holder
    ) {
        if (holder == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        description = description_;
        totalSupply = supply;
        balanceOf[holder] = supply;
        emit Transfer(address(0), holder, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// Plain overwrite, as ERC-20 specifies. Set to 0 first if you care about
    /// the classic allowance race; a pool spends exactly what it was approved.
    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = a - value; }
        }
        _move(from, to, value);
        return true;
    }

    /// Destroy `value` of the caller's own units. Emits Transfer(caller, 0x0, value).
    function burn(uint256 value) external {
        uint256 b = balanceOf[msg.sender];
        if (b < value) revert InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = b - value;
            totalSupply -= value;    // cannot underflow: value <= b <= totalSupply
        }
        emit Transfer(msg.sender, address(0), value);
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - value;
            balanceOf[to] += value;   // cannot overflow: sum of balances == totalSupply
        }
        emit Transfer(from, to, value);
    }
}
