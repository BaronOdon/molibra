// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * V4PositionLocker - a time lock for Uniswap v4 liquidity positions.
 *
 * A v4 position is an ERC-721 held by the PositionManager's owner. Whoever holds
 * it can pull the liquidity out at any moment, which is exactly what a scanner
 * flags as "liquidity not locked". This contract holds the NFT until a date and
 * lets the depositor do ONE thing before then: collect the trading fees.
 *
 *   lock:      positionManager.safeTransferFrom(you, locker, tokenId, abi.encode(uint64 unlockAt))
 *   before:    collectFees(tokenId)  -> fees go to the beneficiary; liquidity stays
 *              extend(tokenId, later) -> the date can only move LATER
 *   after:     withdraw(tokenId)     -> the NFT goes back to the beneficiary
 *
 * What is absent BY CONSTRUCTION, not switched off:
 *   - no owner, no admin, no fee, no upgrade, no pause
 *   - no path that removes liquidity before `unlockAt`: the only call this
 *     contract makes into the PositionManager is DECREASE_LIQUIDITY with a
 *     liquidity of ZERO (which in v4 is how fees are collected) followed by
 *     TAKE_PAIR to the beneficiary
 *   - no way to shorten a lock
 *
 * Only NFTs sent by the configured PositionManager are accepted, so the
 * contract cannot be stuffed with look-alike tokens. Each lock records who
 * sent the NFT; that address is the beneficiary and may hand the role on.
 *
 * ⛔ Lock with safeTransferFrom WITH the unlock data. A plain transferFrom never
 * calls onERC721Received, records no lock and no beneficiary, and the NFT is
 * stuck here for good - the one irreversible mistake available, stated here
 * and on the page that prepares the call.
 *
 * No external imports: the file is read in full by anybody who wants to know
 * whether the liquidity they are trading against can leave.
 */

interface IPositionManagerLike {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract V4PositionLocker {
    /// Uniswap v4 periphery action codes (v4-periphery src/libraries/Actions.sol).
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant TAKE_PAIR = 0x11;

    IPositionManagerLike public immutable positionManager;

    struct Lock {
        address beneficiary;
        uint64 unlockAt;
    }

    mapping(uint256 => Lock) public locks;

    event Locked(uint256 indexed tokenId, address indexed beneficiary, uint64 unlockAt);
    event Extended(uint256 indexed tokenId, uint64 unlockAt);
    event BeneficiaryChanged(uint256 indexed tokenId, address indexed beneficiary);
    event FeesCollected(uint256 indexed tokenId, address indexed to);
    event Withdrawn(uint256 indexed tokenId, address indexed to);

    error NotPositionManager();
    error NotBeneficiary();
    error AlreadyLocked();
    error NotLocked();
    error UnlockInPast();
    error StillLocked(uint64 unlockAt);
    error NotLater();
    error ZeroAddress();

    constructor(address positionManager_) {
        if (positionManager_ == address(0)) revert ZeroAddress();
        positionManager = IPositionManagerLike(positionManager_);
    }

    modifier onlyBeneficiary(uint256 tokenId) {
        Lock memory l = locks[tokenId];
        if (l.beneficiary == address(0)) revert NotLocked();
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        _;
    }

    /// The lock is made here, by the act of sending the NFT with its date.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        if (from == address(0)) revert ZeroAddress();
        if (locks[tokenId].beneficiary != address(0)) revert AlreadyLocked();
        uint64 unlockAt = abi.decode(data, (uint64));
        if (unlockAt <= block.timestamp) revert UnlockInPast();
        locks[tokenId] = Lock(from, unlockAt);
        emit Locked(tokenId, from, unlockAt);
        return this.onERC721Received.selector;
    }

    /// Move the date later. Never earlier.
    function extend(uint256 tokenId, uint64 unlockAt) external onlyBeneficiary(tokenId) {
        if (unlockAt <= locks[tokenId].unlockAt) revert NotLater();
        locks[tokenId].unlockAt = unlockAt;
        emit Extended(tokenId, unlockAt);
    }

    function setBeneficiary(uint256 tokenId, address beneficiary) external onlyBeneficiary(tokenId) {
        if (beneficiary == address(0)) revert ZeroAddress();
        locks[tokenId].beneficiary = beneficiary;
        emit BeneficiaryChanged(tokenId, beneficiary);
    }

    /// Collect the position's accrued fees to the beneficiary. Liquidity is untouched:
    /// DECREASE_LIQUIDITY by 0, then TAKE_PAIR of whatever the fees came to.
    function collectFees(uint256 tokenId) external onlyBeneficiary(tokenId) {
        (IPositionManagerLike.PoolKey memory key,) = positionManager.getPoolAndPositionInfo(tokenId);
        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, msg.sender);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        emit FeesCollected(tokenId, msg.sender);
    }

    /// After the date, and only then, the NFT goes back to the beneficiary.
    function withdraw(uint256 tokenId) external onlyBeneficiary(tokenId) {
        uint64 unlockAt = locks[tokenId].unlockAt;
        if (block.timestamp < unlockAt) revert StillLocked(unlockAt);
        delete locks[tokenId];
        positionManager.transferFrom(address(this), msg.sender, tokenId);
        emit Withdrawn(tokenId, msg.sender);
    }

    /// Seconds until the lock opens; 0 once it is open or if nothing is locked.
    function remaining(uint256 tokenId) external view returns (uint256) {
        uint64 u = locks[tokenId].unlockAt;
        return u > block.timestamp ? u - block.timestamp : 0;
    }
}
