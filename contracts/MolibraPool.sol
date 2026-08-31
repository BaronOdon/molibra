// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MolibraPool - a constant-product market between MOLI and one ERC-20.
 *
 * MOLI is the NATIVE coin of Molibra, not a token, so this is shaped like
 * Uniswap V1 (native + token) rather than V2 (token + token). The native side
 * arrives as `msg.value`; there is no wrapped-MOLI contract and deliberately
 * so, because a wrapper would be one more contract holding everybody's balance.
 *
 * ⛔ WHAT THIS MAY NOT TOUCH
 *
 * Molibra's token registry - GIZ and every other expression token - is
 * consensus state, not ERC-20 state. It is unreachable from bytecode by
 * construction: the EVM's view of state exposes accounts, code and storage and
 * nothing else. So no pool can ever be made in an electoral token, whatever
 * address is passed to the constructor: there is no contract to call, because
 * those tokens are not contracts. That is not a rule this file enforces - it
 * is a rule this file CANNOT break, which is stronger.
 *
 * ⛔ NO ORACLE. This exposes no cumulative price and no TWAP, on purpose. A
 * pool this thin would be an oracle that costs almost nothing to move, and
 * publishing one invites somebody to build on it. Read the reserves if you
 * want a spot price, and know what you are reading.
 */

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address owner) external view returns (uint256);
}

contract MolibraPool {
    /// The 0.3% fee, as numerator/denominator over the input amount.
    uint256 public constant FEE_NUM = 997;
    uint256 public constant FEE_DEN = 1000;

    /// Burned on the first deposit so the pool can never be fully drained and
    /// re-founded at an attacker's price. Uniswap learned this the hard way.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    IERC20 public immutable token;

    uint256 public reserveMoli;
    uint256 public reserveToken;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    bool private entered;

    event Minted(address indexed to, uint256 moli, uint256 tokens, uint256 shares);
    event Burned(address indexed from, uint256 moli, uint256 tokens, uint256 shares);
    event Swapped(address indexed by, bool moliIn, uint256 amountIn, uint256 amountOut);

    error Reentrant();
    error Insufficient();
    error Imbalanced();
    error TransferFailed();

    /// Reserves are tracked in storage rather than read from balances, so a
    /// plain transfer into this contract cannot move the price.
    modifier lock() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    constructor(address erc20) {
        token = IERC20(erc20);
    }

    // --------------------------------------------------------- liquidity

    /**
     * Add liquidity. The caller must have approved this contract for
     * `tokenAmount` first.
     *
     * The first deposit sets the price - there is nothing else for it to be
     * measured against - and permanently burns MINIMUM_LIQUIDITY shares.
     * Every later deposit must match the current ratio or it is refused
     * rather than silently repriced.
     */
    function addLiquidity(uint256 tokenAmount, uint256 minShares)
        external payable lock returns (uint256 minted)
    {
        if (msg.value == 0 || tokenAmount == 0) revert Insufficient();

        if (totalShares == 0) {
            minted = sqrt(msg.value * tokenAmount);
            if (minted <= MINIMUM_LIQUIDITY) revert Insufficient();
            minted -= MINIMUM_LIQUIDITY;
            totalShares = MINIMUM_LIQUIDITY;          // burned, owned by nobody
        } else {
            // Both sides must be offered in proportion. Taking the minimum and
            // keeping the excess would quietly charge the depositor for the
            // difference.
            uint256 byMoli = (msg.value * totalShares) / reserveMoli;
            uint256 byToken = (tokenAmount * totalShares) / reserveToken;
            if (byMoli != byToken) {
                // Allow one unit of rounding, refuse a real imbalance.
                uint256 gap = byMoli > byToken ? byMoli - byToken : byToken - byMoli;
                if (gap > 1) revert Imbalanced();
            }
            minted = byMoli < byToken ? byMoli : byToken;
            if (minted == 0) revert Insufficient();
        }

        if (minted < minShares) revert Insufficient();
        if (!token.transferFrom(msg.sender, address(this), tokenAmount)) revert TransferFailed();

        reserveMoli += msg.value;
        reserveToken += tokenAmount;
        totalShares += minted;
        shares[msg.sender] += minted;
        emit Minted(msg.sender, msg.value, tokenAmount, minted);
    }

    /** Withdraw a share of both reserves, proportionally. */
    function removeLiquidity(uint256 amount, uint256 minMoli, uint256 minTokens)
        external lock returns (uint256 moliOut, uint256 tokenOut)
    {
        if (amount == 0 || shares[msg.sender] < amount) revert Insufficient();
        moliOut = (amount * reserveMoli) / totalShares;
        tokenOut = (amount * reserveToken) / totalShares;
        if (moliOut < minMoli || tokenOut < minTokens) revert Insufficient();

        shares[msg.sender] -= amount;
        totalShares -= amount;
        reserveMoli -= moliOut;
        reserveToken -= tokenOut;

        if (!token.transfer(msg.sender, tokenOut)) revert TransferFailed();
        (bool ok, ) = msg.sender.call{value: moliOut}("");
        if (!ok) revert TransferFailed();
        emit Burned(msg.sender, moliOut, tokenOut, amount);
    }

    // -------------------------------------------------------------- swap

    /** Output for a given input, after the fee. The whole pricing rule. */
    function quote(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256)
    {
        if (amountIn == 0 || reserveIn == 0 || reserveOut == 0) return 0;
        uint256 withFee = amountIn * FEE_NUM;
        return (withFee * reserveOut) / (reserveIn * FEE_DEN + withFee);
    }

    /** MOLI in, tokens out. */
    function swapMoliForToken(uint256 minOut) external payable lock returns (uint256 out) {
        if (msg.value == 0) revert Insufficient();
        out = quote(msg.value, reserveMoli, reserveToken);
        if (out == 0 || out < minOut) revert Insufficient();
        reserveMoli += msg.value;
        reserveToken -= out;
        if (!token.transfer(msg.sender, out)) revert TransferFailed();
        emit Swapped(msg.sender, true, msg.value, out);
    }

    /** Tokens in, MOLI out. Requires approval first. */
    function swapTokenForMoli(uint256 amountIn, uint256 minOut)
        external lock returns (uint256 out)
    {
        if (amountIn == 0) revert Insufficient();
        out = quote(amountIn, reserveToken, reserveMoli);
        if (out == 0 || out < minOut) revert Insufficient();
        if (!token.transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();
        reserveToken += amountIn;
        reserveMoli -= out;
        (bool ok, ) = msg.sender.call{value: out}("");
        if (!ok) revert TransferFailed();
        emit Swapped(msg.sender, false, amountIn, out);
    }

    // ------------------------------------------------------------- views

    /// Spot price only. See the note about oracles at the top of this file.
    function reserves() external view returns (uint256 moli, uint256 tokens) {
        return (reserveMoli, reserveToken);
    }

    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// Accepting a bare send would credit nobody and be unrecoverable.
    receive() external payable {
        revert Insufficient();
    }
}
