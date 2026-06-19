// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EchoMemoryRegistry
 * @notice A portable, user-owned memory layer for AI companion apps, built for
 *         deployment on the Filecoin EVM (FEVM).
 *
 *         The actual memory content (conversation history, learned facts about
 *         the user) never lives on-chain. It's encrypted client-side and stored
 *         on Filecoin via a storage deal; this contract only holds a pointer
 *         (the CID) to that data plus the access-control logic that decides
 *         which AI apps are allowed to read it.
 *
 *         This is a starter scaffold, not an audited production contract.
 *         Before mainnet deployment you'd want: a re-entrancy guard on the
 *         payable functions, an upgradability pattern (UUPS/Transparent proxy),
 *         and a proper access-control library instead of the hand-rolled
 *         checks below.
 */
contract EchoMemoryRegistry {
    /// @notice One memory vault per user wallet.
    struct MemoryVault {
        string cid;          // Current Filecoin/IPFS CID of the encrypted memory blob
        bytes32 integrityHash; // Hash of the plaintext, checked client-side after decrypt
        uint64 updatedAt;    // Block timestamp of last write
        uint256 renewalBalance; // FIL held to fund perpetual storage renewal
    }

    /// @dev user => vault
    mapping(address => MemoryVault) private vaults;

    /// @dev user => app address => has read access
    mapping(address => mapping(address => bool)) private accessList;

    /// @dev user => list of app addresses ever granted access (for enumeration in UIs)
    mapping(address => address[]) private grantedAppsHistory;

    /// @dev Re-entrancy guard state, hand-rolled to avoid an external dependency.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private reentrancyStatus = NOT_ENTERED;

    modifier nonReentrant() {
        require(reentrancyStatus != ENTERED, "ReentrancyGuard: reentrant call");
        reentrancyStatus = ENTERED;
        _;
        reentrancyStatus = NOT_ENTERED;
    }

    event MemoryUpdated(address indexed user, string cid, bytes32 integrityHash, uint64 updatedAt);
    event AccessGranted(address indexed user, address indexed app);
    event AccessRevoked(address indexed user, address indexed app);
    event RenewalFunded(address indexed user, uint256 amount, uint256 newBalance);
    event RenewalWithdrawn(address indexed user, uint256 amount);

    error NotAuthorized();
    error EmptyCID();
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlySelfOrGrantedApp(address user) {
        if (msg.sender != user && !accessList[user][msg.sender]) revert NotAuthorized();
        _;
    }

    /**
     * @notice Write or update the pointer to a user's encrypted memory file.
     * @param cid Filecoin/IPFS content identifier for the encrypted memory blob.
     * @param integrityHash Hash of the decrypted content, used client-side to
     *        confirm the retrieved data matches what was written (paired with
     *        Filecoin's own Proof of Data Possession at the storage layer).
     */
    function updateMemory(string calldata cid, bytes32 integrityHash) external {
        if (bytes(cid).length == 0) revert EmptyCID();
        MemoryVault storage vault = vaults[msg.sender];
        vault.cid = cid;
        vault.integrityHash = integrityHash;
        vault.updatedAt = uint64(block.timestamp);
        emit MemoryUpdated(msg.sender, cid, integrityHash, vault.updatedAt);
    }

    /**
     * @notice Grant a specific AI app contract/address permission to read your memory.
     * @param app The address representing the AI app requesting access.
     */
    function grantAccess(address app) external {
        require(app != address(0), "Cannot grant access to zero address");
        if (!accessList[msg.sender][app]) {
            accessList[msg.sender][app] = true;
            // Only append if this is the first grant (avoid duplicates on re-grant after revoke)
            address[] storage history = grantedAppsHistory[msg.sender];
            bool found = false;
            for (uint256 i = 0; i < history.length; i++) {
                if (history[i] == app) { found = true; break; }
            }
            if (!found) history.push(app);
            emit AccessGranted(msg.sender, app);
        }
    }

    /**
     * @notice Revoke a previously granted app's access. This is what makes
     *         switching apps safe: leaving one companion app doesn't mean
     *         leaving your data exposed to it forever.
     */
    function revokeAccess(address app) external {
        if (accessList[msg.sender][app]) {
            accessList[msg.sender][app] = false;
            emit AccessRevoked(msg.sender, app);
        }
    }

    /**
     * @notice Read a user's current memory pointer. Callable by the user
     *         themself or by any app address they've granted access to.
     */
    function getMemory(address user)
        external
        view
        onlySelfOrGrantedApp(user)
        returns (string memory cid, bytes32 integrityHash, uint64 updatedAt)
    {
        MemoryVault storage vault = vaults[user];
        return (vault.cid, vault.integrityHash, vault.updatedAt);
    }

    /// @notice Check whether a given app currently has access to a user's memory.
    function hasAccess(address user, address app) external view returns (bool) {
        return accessList[user][app];
    }

    /**
     * @notice Top up the FIL endowment that funds automatic storage-deal
     *         renewal for this vault, mirroring Filecoin's perpetual-storage
     *         actor pattern: as long as the balance is funded, an off-chain
     *         keeper (or, longer-term, an FVM actor) keeps renewing the deal
     *         so the memory file never expires.
     */
    function fundRenewal() external payable {
        MemoryVault storage vault = vaults[msg.sender];
        vault.renewalBalance += msg.value;
        emit RenewalFunded(msg.sender, msg.value, vault.renewalBalance);
    }

    /// @notice Withdraw any unused renewal funds back to the user.
    function withdrawRenewal(uint256 amount) external nonReentrant {
        MemoryVault storage vault = vaults[msg.sender];
        if (amount == 0 || amount > vault.renewalBalance) revert NothingToWithdraw();
        vault.renewalBalance -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit RenewalWithdrawn(msg.sender, amount);
    }

    /// @notice View the current renewal balance for a vault.
    function renewalBalanceOf(address user) external view returns (uint256) {
        return vaults[user].renewalBalance;
    }

    /// @notice Enumerate every app ever granted access (UIs filter out revoked ones via hasAccess).
    function appAccessHistory(address user) external view returns (address[] memory) {
        return grantedAppsHistory[user];
    }
}
