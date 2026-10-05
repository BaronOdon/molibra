// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * Test doubles for V4PositionLocker and TokenVesting. NEVER deployed anywhere
 * but the test EVM.
 *
 * MockPositionManager is the smallest thing that behaves like the v4
 * PositionManager from the locker's point of view: an ERC-721 whose
 * safeTransferFrom calls onERC721Received, getPoolAndPositionInfo, and a
 * modifyLiquidities that DECODES the action list and REFUSES any
 * DECREASE_LIQUIDITY with a non-zero liquidity - so a locker that tried to pull
 * liquidity out would fail its test rather than pass it.
 */

interface IReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract MockPositionManager {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint256) public liquidity;
    mapping(uint256 => PoolKey) internal keys;
    uint256 public feeCollections;
    address public lastTakeRecipient;

    error NotOwner();
    error LiquidityRemoved();
    error BadActions();

    function mint(address to, uint256 tokenId, uint256 liq, address c0, address c1) external {
        ownerOf[tokenId] = to;
        liquidity[tokenId] = liq;
        keys[tokenId] = PoolKey(c0, c1, 2500, 25, address(0));
    }

    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256) {
        return (keys[tokenId], 0);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (ownerOf[tokenId] != from || msg.sender != from) revert NotOwner();
        ownerOf[tokenId] = to;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(IReceiver(to).onERC721Received(msg.sender, from, tokenId, data) == IReceiver.onERC721Received.selector, "receiver");
        }
    }

    /// Owner-only, like the real one; a liquidity DECREASE of anything but 0 is refused.
    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        if (actions.length != 2 || uint8(actions[0]) != 0x01 || uint8(actions[1]) != 0x11) revert BadActions();
        (uint256 tokenId, uint256 liq,,,) = abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        if (ownerOf[tokenId] != msg.sender) revert NotOwner();
        if (liq != 0) revert LiquidityRemoved();
        (address c0, address c1, address to) = abi.decode(params[1], (address, address, address));
        if (c0 != keys[tokenId].currency0 || c1 != keys[tokenId].currency1) revert BadActions();
        feeCollections += 1;
        lastTakeRecipient = to;
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
}
