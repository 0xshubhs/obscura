// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Plaintext-only treasury for collecting platform fees from Obscura.
///         Mirrors the FHENIX Treasury: owner-controlled fee bps (cap 10%), authorized
///         contract whitelist, and an ETH withdraw path. The encrypted fee transfer
///         happens in the auction contract via cUSDC, not here.
contract Treasury {
    uint16 public constant MAX_FEE_BPS = 1_000;

    address public owner;
    uint16 public feeBasisPoints;
    mapping(address => bool) public authorizedContracts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeUpdated(uint16 newFeeBps);
    event ContractAuthorized(address indexed contractAddr);
    event ContractRevoked(address indexed contractAddr);
    event EthReceived(address indexed from, uint256 amount);
    event EthWithdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error FeeTooHigh();
    error ZeroAddress();
    error WithdrawFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint16 initialFeeBps) {
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        owner = msg.sender;
        feeBasisPoints = initialFeeBps;
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeeUpdated(initialFeeBps);
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    function setFeeBasisPoints(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBasisPoints = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function authorizeContract(address contractAddr) external onlyOwner {
        if (contractAddr == address(0)) revert ZeroAddress();
        authorizedContracts[contractAddr] = true;
        emit ContractAuthorized(contractAddr);
    }

    function revokeContract(address contractAddr) external onlyOwner {
        authorizedContracts[contractAddr] = false;
        emit ContractRevoked(contractAddr);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit EthWithdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
