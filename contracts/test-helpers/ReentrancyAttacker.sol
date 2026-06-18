// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEchoMemoryRegistry {
    function fundRenewal() external payable;
    function withdrawRenewal(uint256 amount) external;
}

/**
 * @title ReentrancyAttacker
 * @notice Test-only helper. Attempts to re-enter EchoMemoryRegistry.withdrawRenewal
 *         from its receive() callback, to prove the target's nonReentrant guard
 *         actually blocks the exploit rather than just existing as decoration.
 *         Not part of the product — lives only to be exercised by the test suite.
 */
contract ReentrancyAttacker {
    IEchoMemoryRegistry public target;
    uint256 public attackAmount;
    bool public attacking;

    constructor(address _target) {
        target = IEchoMemoryRegistry(_target);
    }

    function fund() external payable {
        target.fundRenewal{value: msg.value}();
    }

    function attack(uint256 amount) external {
        attackAmount = amount;
        attacking = true;
        target.withdrawRenewal(amount);
    }

    receive() external payable {
        if (attacking) {
            attacking = false; // only try once to keep this readable
            target.withdrawRenewal(attackAmount);
        }
    }
}
