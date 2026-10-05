// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * TokenVesting - holds a reserve of ONE ERC-20 and releases it on a fixed
 * schedule to ONE beneficiary. Used for the operator's reserve of a new coin,
 * so that the deployer does not hold the supply (the "creator holds ~100%"
 * flag every scanner raises) and so that anyone can read, on-chain, how much
 * of the reserve can move and when.
 *
 *   released by time t =  0                                  if t < start + cliff
 *                         total * (t - start) / duration     if inside the schedule
 *                         total                              after start + duration
 *
 * where total = what the contract holds + what it has already released. Funding
 * is a plain transfer of the token to this address, after deployment.
 *
 * What is absent BY CONSTRUCTION: no owner, no revoke, no way to change the
 * token, the beneficiary or the schedule, no way to pull out any OTHER token
 * sent here by mistake (it stays here: said plainly rather than adding an
 * admin to rescue it). `release()` may be called by anybody; it can only ever
 * pay the beneficiary.
 *
 * No external imports.
 */

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

contract TokenVesting {
    IERC20Like public immutable token;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable cliff;      // seconds after start before anything vests
    uint64 public immutable duration;   // seconds from start to fully vested

    uint256 public released;

    event Released(uint256 amount);

    error ZeroAddress();
    error BadSchedule();
    error NothingToRelease();
    error TransferFailed();

    constructor(address token_, address beneficiary_, uint64 start_, uint64 cliff_, uint64 duration_) {
        if (token_ == address(0) || beneficiary_ == address(0)) revert ZeroAddress();
        if (duration_ == 0 || cliff_ > duration_) revert BadSchedule();
        token = IERC20Like(token_);
        beneficiary = beneficiary_;
        start = start_;
        cliff = cliff_;
        duration = duration_;
    }

    function vestedAmount(uint64 timestamp) public view returns (uint256) {
        uint256 total = token.balanceOf(address(this)) + released;
        if (timestamp < start + cliff) return 0;
        if (timestamp >= start + duration) return total;
        return (total * (timestamp - start)) / duration;
    }

    function releasable() public view returns (uint256) {
        return vestedAmount(uint64(block.timestamp)) - released;
    }

    function release() external {
        uint256 amount = releasable();
        if (amount == 0) revert NothingToRelease();
        released += amount;
        if (!token.transfer(beneficiary, amount)) revert TransferFailed();
        emit Released(amount);
    }
}
