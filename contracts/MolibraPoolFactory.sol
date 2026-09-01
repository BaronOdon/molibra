// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./MolibraPool.sol";

/**
 * MolibraPoolFactory — one pool per token, so a market can exist for anything
 * eligible without anybody deploying it by hand.
 *
 * ## Why a factory at all
 *
 * `MolibraPool` pairs the NATIVE coin against one token, Uniswap-V1 shaped.
 * That has a property worth keeping: because every pool has MOLI on one side,
 * **any token can be traded for any other token in exactly two hops**, and no
 * pair-explosion registry is needed. n tokens give n pools, not n².
 *
 * Until now each pool was deployed by hand, which meant the set of tradeable
 * assets was whatever the operator had gotten round to. A factory makes the
 * market permissionless: anyone may create the pool for a token, once.
 *
 * ## ⛔⛔ What can and cannot get a market, and why that is not this file's rule
 *
 * Molibra's expression tokens — GIZ, and anything declaring a `social`,
 * `purchase` or `electoral` purpose — live in the chain's own token registry.
 * **They are not EVM contracts.** There is no bytecode at their id and no
 * `transfer` to call.
 *
 * So this factory cannot create a market in an electoral token no matter what
 * is passed to it: `create` requires code at the address, and there is none.
 * That is structural, not a check that could be forgotten or removed — the
 * regulated instruments are outside the machine entirely, which is the same
 * reason a contract cannot forge an expression.
 *
 * ⛔ The `hasCode` requirement below is therefore a GUARD RAIL, not the
 * mechanism. It exists so the failure is a named error rather than a pool that
 * deploys against a dead address and silently accepts deposits nobody can
 * withdraw.
 *
 * ## What this does NOT do
 *
 * It does not vet the token. Anybody may deploy an ERC-20 and create its pool,
 * and a pool existing means nothing about whether the asset is worth anything
 * or whether its contract is honest. A front end listing markets must say so.
 */
contract MolibraPoolFactory {
    /// token => pool. One pool per token, forever.
    mapping(address => address) public poolOf;

    /// Every token that has a pool, in creation order, so a client can enumerate.
    address[] public tokens;

    event PoolCreated(address indexed token, address indexed pool, uint256 index);

    error AlreadyExists(address pool);
    error NotAContract();
    error ZeroAddress();

    /**
     * Create the pool for `token`.
     *
     * ⛔ Idempotent by refusal rather than by returning the existing pool. Two
     * pools for one token would split its liquidity and give two different
     * prices for the same asset, and a caller who gets a silent no-op cannot
     * tell which of those happened.
     */
    function create(address token) external returns (address pool) {
        if (token == address(0)) revert ZeroAddress();
        if (poolOf[token] != address(0)) revert AlreadyExists(poolOf[token]);

        // ⛔ An expression token has no code, so this is where a market in one
        // fails. See the header: the exclusion is structural and this is the
        // named error for it.
        uint256 size;
        assembly { size := extcodesize(token) }
        if (size == 0) revert NotAContract();

        pool = address(new MolibraPool(token));
        poolOf[token] = pool;
        tokens.push(token);
        emit PoolCreated(token, pool, tokens.length - 1);
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /**
     * Every market, in one call. A page that had to make one request per token
     * to draw a list would make the list the slowest thing on the screen.
     */
    function allMarkets() external view returns (address[] memory ts, address[] memory ps) {
        uint256 n = tokens.length;
        ts = new address[](n);
        ps = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            ts[i] = tokens[i];
            ps[i] = poolOf[tokens[i]];
        }
    }

    /**
     * Reserves for many pools at once, so a client can price a whole token list
     * without n round trips.
     *
     * ⛔ Returns zeros for a token with no pool rather than reverting: a list
     * containing one unknown address should render, not fail entirely.
     */
    function reservesOf(address[] calldata list)
        external view returns (uint256[] memory moli, uint256[] memory toks)
    {
        moli = new uint256[](list.length);
        toks = new uint256[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            address p = poolOf[list[i]];
            if (p == address(0)) continue;
            (uint256 m, uint256 t) = MolibraPool(payable(p)).reserves();
            moli[i] = m;
            toks[i] = t;
        }
    }
}
