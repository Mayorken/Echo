// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/**
 * @title EchoMemoryRegistry
 * @notice Universal AI context portability layer, built for deployment on the
 *         Filecoin EVM (FEVM). Deployed behind an ERC1967 proxy so the
 *         contract can be upgraded without migrating users or AI tool
 *         integrations to a new address.
 *
 *         The actual context (project knowledge, preferences, architectural
 *         decisions accumulated across AI tools) never lives on-chain. It's
 *         encrypted client-side and stored on Filecoin via a storage deal;
 *         this contract only holds a pointer (the CID) to that data plus the
 *         access-control logic that decides which AI tools are allowed to
 *         read it.
 */
contract EchoMemoryRegistry is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    /// @notice One context vault per user wallet.
    struct MemoryVault {
        string cid;             // Current Filecoin/IPFS CID of the encrypted context blob
        bytes32 integrityHash;  // Hash of the plaintext, checked client-side after decrypt
        uint64 updatedAt;       // Block timestamp of last write
        uint256 renewalBalance; // FIL held to fund perpetual storage renewal
    }

    /// @dev user => vault
    mapping(address => MemoryVault) internal vaults;

    /// @dev user => AI tool address => has read access
    mapping(address => mapping(address => bool)) internal accessList;

    /// @dev user => list of AI tool addresses ever granted access (for enumeration in UIs)
    mapping(address => address[]) internal grantedAppsHistory;

    event MemoryUpdated(address indexed user, string cid, bytes32 integrityHash, uint64 updatedAt);
    event AccessGranted(address indexed user, address indexed app);
    event AccessRevoked(address indexed user, address indexed app);
    event RenewalFunded(address indexed user, uint256 amount, uint256 newBalance);
    event RenewalWithdrawn(address indexed user, uint256 amount);

    error NotAuthorized();
    error NothingToWithdraw();
    error TransferFailed();
    error EmptyCid();

    modifier onlySelfOrGrantedApp(address user) {
        if (msg.sender != user && !accessList[user][msg.sender]) revert NotAuthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the proxy instance. Called once at deploy time via
     *         the ERC1967Proxy constructor's _data argument.
     * @param initialOwner The address that will own the contract and be
     *        authorized to perform upgrades.
     */
    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
    }

    /**
     * @notice Write or update the pointer to a user's encrypted context file.
     * @param cid Filecoin/IPFS content identifier for the encrypted context blob.
     * @param integrityHash Hash of the decrypted content, used client-side to
     *        confirm the retrieved data matches what was written (paired with
     *        Filecoin's own Proof of Data Possession at the storage layer).
     */
    function updateMemory(string calldata cid, bytes32 integrityHash) external {
        if (bytes(cid).length == 0) revert EmptyCid();
        MemoryVault storage vault = vaults[msg.sender];
        vault.cid = cid;
        vault.integrityHash = integrityHash;
        vault.updatedAt = uint64(block.timestamp);
        emit MemoryUpdated(msg.sender, cid, integrityHash, vault.updatedAt);
    }

    /**
     * @notice Grant a specific AI tool's contract/address permission to read your context.
     * @param app The address representing the AI tool requesting access.
     */
    function grantAccess(address app) external {
        if (app == address(0)) revert NotAuthorized();
        if (!accessList[msg.sender][app]) {
            accessList[msg.sender][app] = true;
            grantedAppsHistory[msg.sender].push(app);
            emit AccessGranted(msg.sender, app);
        }
    }

    /**
     * @notice Revoke a previously granted tool's access. This is what makes
     *         switching AI tools safe: leaving one platform doesn't mean
     *         leaving your context exposed to it forever.
     */
    function revokeAccess(address app) external {
        if (accessList[msg.sender][app]) {
            accessList[msg.sender][app] = false;
            emit AccessRevoked(msg.sender, app);
        }
    }

    /**
     * @notice Read a user's current context pointer. Callable by the user
     *         themself or by any AI tool address they've granted access to.
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

    /// @notice Check whether a given AI tool currently has access to a user's context.
    function hasAccess(address user, address app) external view returns (bool) {
        return accessList[user][app];
    }

    /**
     * @notice Top up the FIL endowment that funds automatic storage-deal
     *         renewal for this vault, mirroring Filecoin's perpetual-storage
     *         actor pattern: as long as the balance is funded, an off-chain
     *         keeper (or, longer-term, an FVM actor) keeps renewing the deal
     *         so the context file never expires.
     */
    function fundRenewal() external payable {
        if (msg.value == 0) revert NothingToWithdraw();
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

    /// @notice Enumerate every AI tool ever granted access (UIs filter out revoked ones via hasAccess).
    function appAccessHistory(address user) external view returns (address[] memory) {
        return grantedAppsHistory[user];
    }

    /// @dev Only the contract owner can authorize an upgrade to a new implementation.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
