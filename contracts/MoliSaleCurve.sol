// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * MoliSaleCurve - sells ONE token for native MOLI only, on a fixed, rising
 * price schedule, and puts every MOLI it is paid into that token's MolibraPool
 * as liquidity that nobody can ever withdraw.
 *
 * ## The schedule
 *
 * `x` is how many token units have left the curve (to buyers AND into the
 * pool). The marginal price, in MOLI-wei per 1e18 token-wei, is linear:
 *
 *     price(x) = p0 * (S + 4x) / S          p0 at x = 0,  5 * p0 at x = S
 *
 * so buying `t` units starting at `x` costs exactly the area under it:
 *
 *     cost(x, t) = p0 * t * (S + 4x + 2t) / (S * 1e18)       (rounded UP)
 *
 * Price only rises: nothing ever lowers `x`. The curve never buys back; selling
 * happens in the pool.
 *
 * ## Where the MOLI goes, and why it cannot be sandwiched
 *
 * Each buy deposits ITS OWN payment into the pool, in the same transaction,
 * together with tokens from the curve's inventory at the pool's current ratio
 * (MolibraPool only accepts proportional deposits). The LP shares stay in this
 * contract forever: there is no function that removes liquidity.
 *
 *   1. The curve never holds anybody's MOLI between transactions. A deposit
 *      at a manipulated pool price would hand the manipulator the deposit's
 *      impermanent loss - so the only MOLI that can ever be deposited is the
 *      MOLI the caller is paying right now. Pumping the pool to make your own
 *      purchase deposit at a bad price means paying the curve's price for
 *      tokens the market values lower: a loss at every size (simulated).
 *   2. The buy is REFUSED unless the pool's spot price is within BAND_BP
 *      (1%) of the curve's marginal price. The curve price moves only when
 *      somebody pays real MOLI for it, so it is the one price here that
 *      cannot be pushed around for free. The deposit therefore always enters
 *      at a price within 1% of the published schedule.
 *        - pool below the band: buy in the pool, it is cheaper;
 *        - pool above the band: anyone may sell into the pool down to the
 *          band and buy here - the arbitrage that fills the curve.
 *   3. Reentrancy: a lock on every state-changing function, state written
 *      before any external call, and the only external parties are the token,
 *      the pool (both fixed at construction) and the buyer's refund, which
 *      comes after everything else is settled.
 *
 * ## What is absent by construction
 *
 * No owner, no admin, no pause, no withdraw, no way to change the token, the
 * pool, the supply or the price. Tokens sent here beyond the sale supply stay
 * here. MOLI sent with no purchase is refused (receive reverts).
 *
 * No external imports.
 */

interface ICurveToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface ICurvePool {
    function token() external view returns (address);
    function reserves() external view returns (uint256 moli, uint256 tokens);
    function totalShares() external view returns (uint256);
    function addLiquidity(uint256 tokenAmount, uint256 minShares) external payable returns (uint256);
}

contract MoliSaleCurve {
    uint256 public constant BAND_BP = 100;            // pool within +-1% of the curve price
    uint256 private constant ONE = 1e18;

    ICurveToken public immutable token;
    ICurvePool public immutable pool;
    uint256 public immutable supplyForSale;           // S
    uint256 public immutable startPrice;              // p0, MOLI-wei per 1e18 token-wei

    uint256 public sold;                              // x: units that left the curve
    uint256 public moliRaised;                        // all MOLI kept (deposited) by the curve
    bool private entered;

    event Bought(address indexed buyer, uint256 moliPaid, uint256 tokensOut, uint256 priceAfter);
    event Deepened(uint256 moli, uint256 tokens, uint256 shares);

    error ZeroAddress();
    error BadPool();
    error BadParams();
    error Reentrant();
    error Expired();
    error NotFunded();
    error SoldOut();
    error PoolNotSeeded();
    error OutOfBand(uint256 poolPrice, uint256 curvePrice);
    error Slippage();
    error TransferFailed();
    error NoDirectSends();

    modifier lock() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    constructor(address token_, address pool_, uint256 supplyForSale_, uint256 startPrice_) {
        if (token_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        if (ICurvePool(pool_).token() != token_) revert BadPool();
        if (supplyForSale_ == 0 || startPrice_ == 0) revert BadParams();
        // Keeps every intermediate below 2^256 (see cost()).
        if (supplyForSale_ > 1e33 || startPrice_ > 1e33) revert BadParams();
        token = ICurveToken(token_);
        pool = ICurvePool(pool_);
        supplyForSale = supplyForSale_;
        startPrice = startPrice_;
    }

    /* ------------------------------------------------------------- views */

    function priceAt(uint256 x) public view returns (uint256) {
        return (startPrice * (supplyForSale + 4 * x)) / supplyForSale;
    }

    function currentPrice() external view returns (uint256) {
        return priceAt(sold);
    }

    function remaining() public view returns (uint256) {
        return supplyForSale - sold;
    }

    /// MOLI-wei for `t` units starting at `x`, rounded UP (in the curve's favour).
    function cost(uint256 x, uint256 t) public view returns (uint256) {
        // t*(S+4x+2t) <= 1e33 * 7e33 < 2^256; the product with p0 goes through mulDiv.
        return mulDivUp(startPrice, t * (supplyForSale + 4 * x + 2 * t), supplyForSale * ONE);
    }

    /// The pool's spot price in the same units as priceAt.
    function poolPrice() public view returns (uint256) {
        (uint256 rM, uint256 rT) = pool.reserves();
        if (rT == 0) return 0;
        return mulDiv(rM, ONE, rT);
    }

    function inBand() public view returns (bool) {
        uint256 c = priceAt(sold);
        uint256 p = poolPrice();
        return p * 10000 >= c * (10000 - BAND_BP) && p * 10000 <= c * (10000 + BAND_BP);
    }

    /**
     * What `moli` buys right now: (tokens to the buyer, MOLI kept, tokens into
     * the pool, MOLI refunded). Reverts as buy() would, except for slippage.
     */
    function quote(uint256 moli) public view returns (uint256 out, uint256 paid, uint256 toPool, uint256 refund) {
        uint256 x = sold;
        uint256 left = supplyForSale - x;
        if (left == 0) revert SoldOut();
        (uint256 rM, uint256 rT) = pool.reserves();
        uint256 ts = pool.totalShares();
        if (ts == 0 || rM == 0 || rT == 0) revert PoolNotSeeded();

        out = _solve(x, left, moli);
        if (out == 0) revert BadParams();
        paid = cost(x, out);
        (, toPool, ) = _depositFor(paid, rM, rT, ts);
        // The buyer's tokens and the pool's tokens both come out of `left`.
        // Only near sell-out can they not both fit: then find the largest
        // purchase that fits, by bisection (monotonic in `out`).
        if (out + toPool > left) {
            uint256 lo = 0;
            uint256 hi = out;
            while (lo < hi) {
                uint256 mid = (lo + hi + 1) / 2;
                (, uint256 tp, ) = _depositFor(cost(x, mid), rM, rT, ts);
                if (mid + tp <= left) lo = mid; else hi = mid - 1;
            }
            out = lo;
            if (out == 0) revert SoldOut();
            paid = cost(x, out);
            (, toPool, ) = _depositFor(paid, rM, rT, ts);
        }
        refund = moli - paid;
    }

    /* --------------------------------------------------------------- buy */

    /**
     * Buy with the MOLI sent. `minOut`: fewest tokens accepted. `maxPrice`:
     * highest marginal price (MOLI-wei per 1e18 units) at the end of your
     * tokens. Any MOLI the curve cannot use (at sell-out) is refunded.
     */
    function buy(uint256 minOut, uint256 maxPrice, uint256 deadline)
        external payable lock returns (uint256 out)
    {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert BadParams();
        if (token.balanceOf(address(this)) < supplyForSale - sold) revert NotFunded();
        if (!inBand()) revert OutOfBand(poolPrice(), priceAt(sold));

        uint256 paid; uint256 refund;
        (out, paid, , refund) = quote(msg.value);
        if (out < minOut || priceAt(sold + out) > maxPrice) revert Slippage();

        // Effects, then interactions.
        uint256 x = sold;
        sold = x + out;
        moliRaised += paid;
        if (!token.transfer(msg.sender, out)) revert TransferFailed();
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
        _deepen(paid);
        emit Bought(msg.sender, paid, out, priceAt(sold));
    }

    /* ----------------------------------------------------------- deposit */

    /**
     * Deposit `budget` MOLI (at most) with tokens at the pool's ratio. Exact
     * shares on both sides, so MolibraPool's balance check always passes.
     * Any rounding dust (a few wei) stays here and joins the next deposit.
     */
    function _deepen(uint256 budget) private {
        (uint256 rM, uint256 rT) = pool.reserves();
        uint256 ts = pool.totalShares();
        uint256 left = supplyForSale - sold;
        // Rounding dust from earlier deposits (wei) rides along when it fits.
        (uint256 m, uint256 t, uint256 s) = _depositFor(address(this).balance, rM, rT, ts);
        if (t > left || address(this).balance - budget > 1e9) {
            (m, t, s) = _depositFor(budget, rM, rT, ts);
        }
        if (s == 0 || t > left) return;
        sold += t;
        if (!token.approve(address(pool), t)) revert TransferFailed();
        pool.addLiquidity{value: m}(t, s);
        emit Deepened(m, t, s);
    }

    /// (MOLI, tokens, shares) for a proportional deposit of at most `budget` MOLI.
    function _depositFor(uint256 budget, uint256 rM, uint256 rT, uint256 ts)
        private pure returns (uint256 m, uint256 t, uint256 s)
    {
        // Shares minted are floor(m*ts/rM) and floor(t*ts/rT), and MolibraPool
        // wants them equal. The side whose reserve is SMALLER moves in coarser
        // steps (ts/reserve can exceed 1), so the share count is chosen from
        // that side and the finer side is matched to it exactly.
        if (rM <= rT) {
            s = mulDiv(budget, ts, rM);                    // attainable: from m = budget
            if (s == 0) return (0, 0, 0);
            m = mulDivUp(s, rM, ts);                       // smallest m giving s
            t = mulDivUp(s, rT, ts);                       // ts <= rT, so floor(t*ts/rT) == s
        } else {
            uint256 tMax = mulDiv(budget, rT, rM);
            s = mulDiv(tMax, ts, rT);                      // attainable: from t = tMax
            if (s == 0) return (0, 0, 0);
            t = mulDivUp(s, rT, ts);
            m = mulDivUp(s, rM, ts);                       // ts <= rM, so floor(m*ts/rM) == s
            if (m > budget) { s -= 1; t = mulDivUp(s, rT, ts); m = mulDivUp(s, rM, ts); }
            if (s == 0) return (0, 0, 0);
        }
    }

    /// Largest t with cost(x, t) <= moli (capped at `left`).
    function _solve(uint256 x, uint256 left, uint256 moli) private view returns (uint256 t) {
        if (moli >= cost(x, left)) return left;
        // 2t^2 + (S + 4x) t - C = 0,  C = moli * S * 1e18 / p0  (floored: favours the curve)
        uint256 b = supplyForSale + 4 * x;
        uint256 c = mulDiv(moli, supplyForSale * ONE, startPrice);
        t = (sqrt(b * b + 8 * c) - b) / 4;
        if (t > left) t = left;
        while (t > 0 && cost(x, t) > moli) t--;
    }

    receive() external payable {
        // The pool never pays this contract (it never removes liquidity or
        // sells), so any plain send is a mistake: refuse it.
        revert NoDirectSends();
    }

    /* -------------------------------------------------------------- math */

    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y == 0) return 0;
        z = y;
        uint256 x = y / 2 + 1;
        while (x < z) { z = x; x = (y / x + x) / 2; }
    }

    /// floor(a*b/d) with a 512-bit intermediate (Remco Bloemen's method, MIT).
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        uint256 prod0; uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        require(d > prod1, "mulDiv overflow");
        if (prod1 == 0) return prod0 / d;
        uint256 rem;
        assembly {
            rem := mulmod(a, b, d)
            prod1 := sub(prod1, gt(rem, prod0))
            prod0 := sub(prod0, rem)
        }
        // ⛔ Everything below is arithmetic mod 2^256 BY DESIGN (Newton's
        // inverse and the 512-bit fold). In checked mode it panics with 0x11 -
        // found by the CARAMELO-sized test, the first to reach this path.
        unchecked {
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            inv *= 2 - d * inv; inv *= 2 - d * inv; inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }

    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 r) {
        r = mulDiv(a, b, d);
        if (mulmod(a, b, d) > 0) r += 1;
    }
}
