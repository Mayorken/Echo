// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EchoMemoryRegistry.sol";

/**
 * @title EchoMemoryRegistryV2
 * @notice Example upgrade target that proves the UUPS pattern works:
 *         adds a version() getter while preserving all V1 storage and
 *         behavior. Used by the test suite to exercise the upgrade flow.
 */
contract EchoMemoryRegistryV2 is EchoMemoryRegistry {
    function version() external pure virtual returns (uint256) {
        return 2;
    }
}
