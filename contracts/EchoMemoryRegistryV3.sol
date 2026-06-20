// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./EchoMemoryRegistryV2.sol";

/**
 * @title EchoMemoryRegistryV3
 * @notice Adds two protocol-level capabilities while preserving all V1/V2 storage:
 *
 *   1. Team Vaults — on-chain RBAC for shared context. A vault owner creates a
 *      named vault (bytes32 id), then calls grantVaultAccess() to add teammates
 *      directly on-chain. Any member can read or write. No central server needed.
 *
 *   2. Keeper Spend Path — authorized Keeper addresses can call keeperDeductRenewal()
 *      to pull from a user's on-chain renewalBalance to cover re-pinning costs.
 *      This makes the Keeper self-sustaining without a subscription model: the user
 *      pre-funds their vault, any Keeper can service it and get reimbursed on-chain.
 *
 * Storage layout strictly appends after V1's three mappings. V2 added no storage.
 */
contract EchoMemoryRegistryV3 is EchoMemoryRegistryV2 {

    // =========================================================================
    // New storage — appended after all V1 slots
    // =========================================================================

    /// @dev Addresses authorized to call keeperDeductRenewal()
    mapping(address => bool) internal _authorizedKeepers;

    /// @dev vaultId => creator/owner address
    mapping(bytes32 => address) private _vaultOwner;

    /// @dev vaultId => current CID of the encrypted shared context blob
    mapping(bytes32 => string) private _vaultCid;

    /// @dev vaultId => integrity hash of the shared context plaintext
    mapping(bytes32 => bytes32) private _vaultIntegrityHash;

    /// @dev vaultId => block timestamp of last vault write
    mapping(bytes32 => uint64) private _vaultUpdatedAt;

    /// @dev vaultId => member address => has read/write access
    mapping(bytes32 => mapping(address => bool)) private _vaultMembers;

    /// @dev vaultId => ordered list of all addresses ever granted access (for UI enumeration)
    mapping(bytes32 => address[]) private _vaultMemberList;

    // =========================================================================
    // Events
    // =========================================================================

    event KeeperAdded(address indexed keeper);
    event KeeperRemoved(address indexed keeper);
    event KeeperReimbursed(address indexed keeper, address indexed user, uint256 amount);
    event VaultCreated(bytes32 indexed vaultId, address indexed owner);
    event VaultMemoryUpdated(bytes32 indexed vaultId, address indexed updatedBy, string cid, bytes32 integrityHash, uint64 updatedAt);
    event VaultAccessGranted(bytes32 indexed vaultId, address indexed member);
    event VaultAccessRevoked(bytes32 indexed vaultId, address indexed member);

    // =========================================================================
    // Errors
    // =========================================================================

    error NotKeeper();
    error VaultAlreadyExists();
    error VaultNotFound();
    error NotVaultOwner();
    error InsufficientRenewalBalance();

    // =========================================================================
    // Version
    // =========================================================================

    function version() external pure override returns (uint256) {
        return 3;
    }

    // =========================================================================
    // Keeper Management — only contract owner may authorize keepers
    // =========================================================================

    /**
     * @notice Authorize a Keeper address to call keeperDeductRenewal().
     *         Any third party can run a Keeper — this is what makes the protocol
     *         decentralized. The owner doesn't service vaults; they only vouch
     *         for which Keeper addresses are permitted to pull funds.
     *
     *         Trust model: an authorized keeper can deduct up to a user's full
     *         renewalBalance in a single call. If the owner's key is compromised
     *         an attacker could add a malicious keeper and drain all funded vaults.
     *         Mitigations: use a multisig as owner, monitor KeeperAdded events,
     *         and keep renewalBalances sized to near-term renewal costs only.
     */
    function addKeeper(address keeper) external onlyOwner {
        if (keeper == address(0)) revert NotAuthorized();
        if (!_authorizedKeepers[keeper]) {
            _authorizedKeepers[keeper] = true;
            emit KeeperAdded(keeper);
        }
    }

    function removeKeeper(address keeper) external onlyOwner {
        if (_authorizedKeepers[keeper]) {
            _authorizedKeepers[keeper] = false;
            emit KeeperRemoved(keeper);
        }
    }

    function isKeeper(address addr) external view returns (bool) {
        return _authorizedKeepers[addr];
    }

    // =========================================================================
    // Keeper Spend Path
    // =========================================================================

    /**
     * @notice Deduct `amount` from a user's renewalBalance and transfer it to
     *         the calling Keeper as reimbursement for re-pinning costs.
     *
     *         Only callable by addresses in _authorizedKeepers. The user's
     *         balance is the ceiling — a Keeper can never pull more than was
     *         pre-funded. Combined with reentrancy protection this means the
     *         only risk is an over-eager Keeper draining a balance to zero,
     *         which stops future re-pins (a self-limiting failure mode).
     *
     * @param user    The vault owner whose renewalBalance is debited.
     * @param amount  Wei to transfer to the calling Keeper.
     */
    function keeperDeductRenewal(address user, uint256 amount) external nonReentrant {
        if (!_authorizedKeepers[msg.sender]) revert NotKeeper();
        MemoryVault storage vault = vaults[user];
        if (amount == 0 || amount > vault.renewalBalance) revert InsufficientRenewalBalance();
        vault.renewalBalance -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit KeeperReimbursed(msg.sender, user, amount);
    }

    // =========================================================================
    // Team Vaults
    // =========================================================================

    /**
     * @notice Create a new shared vault with the caller as owner.
     *         vaultId is a bytes32 — callers should use keccak256 of a team name
     *         (e.g. ethers.id("my-team")) so the same string always maps to the
     *         same vault. Ownership cannot be transferred; create a new vault
     *         instead of trying to migrate ownership.
     */
    function createVault(bytes32 vaultId) external {
        if (_vaultOwner[vaultId] != address(0)) revert VaultAlreadyExists();
        _vaultOwner[vaultId] = msg.sender;
        _vaultMembers[vaultId][msg.sender] = true;
        _vaultMemberList[vaultId].push(msg.sender);
        emit VaultCreated(vaultId, msg.sender);
        emit VaultAccessGranted(vaultId, msg.sender);
    }

    /**
     * @notice Write or update the shared context pointer for a team vault.
     *         Any current member (not just the owner) can write — the team
     *         owns the vault collectively. Client-side AES-256-GCM encryption
     *         ensures the stored bytes are unreadable to anyone without the key.
     */
    function updateVaultMemory(
        bytes32 vaultId,
        string calldata cid,
        bytes32 integrityHash
    ) external {
        if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound();
        if (!_vaultMembers[vaultId][msg.sender]) revert NotAuthorized();
        if (bytes(cid).length == 0) revert EmptyCid();
        _vaultCid[vaultId] = cid;
        _vaultIntegrityHash[vaultId] = integrityHash;
        _vaultUpdatedAt[vaultId] = uint64(block.timestamp);
        emit VaultMemoryUpdated(vaultId, msg.sender, cid, integrityHash, uint64(block.timestamp));
    }

    /**
     * @notice Read the current context pointer for a team vault.
     *         Only vault members can call this — a non-member gets NotAuthorized.
     */
    function getVaultMemory(bytes32 vaultId)
        external
        view
        returns (string memory cid, bytes32 integrityHash, uint64 updatedAt)
    {
        if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound();
        if (!_vaultMembers[vaultId][msg.sender]) revert NotAuthorized();
        return (_vaultCid[vaultId], _vaultIntegrityHash[vaultId], _vaultUpdatedAt[vaultId]);
    }

    /**
     * @notice Grant a teammate access to a vault. Only the vault owner can
     *         add new members — teammates cannot invite others without owner sign-off.
     */
    function grantVaultAccess(bytes32 vaultId, address member) external {
        if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound();
        if (_vaultOwner[vaultId] != msg.sender) revert NotVaultOwner();
        if (member == address(0)) revert NotAuthorized();
        if (!_vaultMembers[vaultId][member]) {
            _vaultMembers[vaultId][member] = true;
            _vaultMemberList[vaultId].push(member);
            emit VaultAccessGranted(vaultId, member);
        }
    }

    /**
     * @notice Revoke a member's access. Only the vault owner can remove members.
     *         The owner cannot revoke themselves (the vault would become write-locked).
     */
    function revokeVaultAccess(bytes32 vaultId, address member) external {
        if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound();
        if (_vaultOwner[vaultId] != msg.sender) revert NotVaultOwner();
        if (member == msg.sender) revert NotAuthorized();
        if (_vaultMembers[vaultId][member]) {
            _vaultMembers[vaultId][member] = false;
            emit VaultAccessRevoked(vaultId, member);
        }
    }

    /// @notice Check whether an address is currently a member of a vault.
    function hasVaultAccess(bytes32 vaultId, address member) external view returns (bool) {
        return _vaultMembers[vaultId][member];
    }

    /// @notice Return the vault owner's address (zero if vault doesn't exist).
    function getVaultOwner(bytes32 vaultId) external view returns (address) {
        return _vaultOwner[vaultId];
    }

    /**
     * @notice Return every address ever granted access. Callers should filter
     *         the result through hasVaultAccess() to identify currently active members.
     *         Only vault members can enumerate the list.
     */
    function getVaultMembers(bytes32 vaultId) external view returns (address[] memory) {
        if (_vaultOwner[vaultId] == address(0)) revert VaultNotFound();
        if (!_vaultMembers[vaultId][msg.sender]) revert NotAuthorized();
        return _vaultMemberList[vaultId];
    }

}
