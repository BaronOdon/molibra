// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// Test-only: a curve BENEFICIARY that, while receiving the MOLI of a
/// withdrawal, tries to withdraw again (or to buy). The curve's lock must
/// refuse it, and the whole withdrawal must unwind.
interface ICurveW {
    function withdrawLiquidity(uint256 shares, uint256 minMoli, uint256 minTokens) external returns (uint256, uint256);
    function buy(uint256 minOut, uint256 maxPrice, uint256 deadline) external payable returns (uint256);
}

contract CurveBeneficiaryReenter {
    ICurveW public curve;
    uint256 public mode;          // 0: accept quietly, 1: re-enter withdraw, 2: re-enter buy

    function setCurve(address c) external { curve = ICurveW(c); }
    function setMode(uint256 m) external { mode = m; }

    function pull(uint256 shares) external {
        curve.withdrawLiquidity(shares, 0, 0);
    }

    receive() external payable {
        if (mode == 1) { mode = 0; curve.withdrawLiquidity(1, 0, 0); }
        else if (mode == 2) { mode = 0; curve.buy{value: 1 ether}(0, type(uint256).max, type(uint256).max); }
    }
}
