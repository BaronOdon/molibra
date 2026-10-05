// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// Test-only: a buyer that tries to buy again from inside its refund.
interface ICurveBuy {
    function buy(uint256 minOut, uint256 maxPrice, uint256 deadline) external payable returns (uint256);
}

contract CurveReenter {
    ICurveBuy public immutable curve;
    bool public tried;

    constructor(address curve_) { curve = ICurveBuy(curve_); }

    function attack() external payable {
        curve.buy{value: msg.value}(0, type(uint256).max, type(uint256).max);
    }

    receive() external payable {
        if (!tried) {
            tried = true;
            // Re-enter with the refund. The curve's lock must refuse this, and
            // the refund call failing must revert the whole purchase.
            curve.buy{value: msg.value}(0, type(uint256).max, type(uint256).max);
        }
    }
}
