/**
 * keeper/renewer.js
 *
 * Checks Lighthouse deal status for each CID and re-pins any whose
 * Filecoin deals are expiring or have no active deal. The re-pin
 * ensures the data stays retrievable via the IPFS gateway.
 *
 * Current limitation: the keeper operator pays for re-pinning via
 * their Lighthouse API key. The on-chain renewalBalance is tracked
 * as a commitment signal but not yet deducted automatically — that
 * requires a contract upgrade to add a keeper-authorized spend path.
 */

const lighthouse = require('@lighthouse-web3/sdk');

/**
 * Status values returned by checkDealStatus:
 * - 'active':  at least one Filecoin deal is live
 * - 'expiring': deal exists but is within the renewal window
 * - 'no-deal': no Filecoin deal found (only IPFS pinned)
 * - 'error':   could not determine status
 */

const DEFAULT_EXPIRY_THRESHOLD_EPOCHS = 2880; // ~1 day in Filecoin epochs (30s each)

/**
 * Check the Filecoin deal status for a CID via Lighthouse.
 *
 * @param {string} cid
 * @param {object} [options]
 * @param {number} [options.expiryThresholdEpochs] Epochs before expiry to trigger renewal
 * @returns {Promise<{status: string, deals: Array}>}
 */
async function checkDealStatus(cid, options) {
  const threshold = (options && options.expiryThresholdEpochs) || DEFAULT_EXPIRY_THRESHOLD_EPOCHS;

  try {
    const response = await lighthouse.dealStatus(cid);
    const deals = (response && response.data) || [];

    if (!Array.isArray(deals) || deals.length === 0) {
      return { status: 'no-deal', deals: [] };
    }

    const hasActive = deals.some(
      (d) => d.dealStatus === 'active' || d.storageStatus === 'active'
    );

    if (!hasActive) {
      const hasExpiring = deals.some((d) => {
        const endEpoch = Number(d.endEpoch || d.expiration || 0);
        const currentEpoch = Number(d.currentEpoch || d.chainEpoch || 0);
        return endEpoch > 0 && currentEpoch > 0 && (endEpoch - currentEpoch) < threshold;
      });
      return { status: hasExpiring ? 'expiring' : 'no-deal', deals };
    }

    const nearExpiry = deals.some((d) => {
      if (d.dealStatus !== 'active' && d.storageStatus !== 'active') return false;
      const endEpoch = Number(d.endEpoch || d.expiration || 0);
      const currentEpoch = Number(d.currentEpoch || d.chainEpoch || 0);
      return endEpoch > 0 && currentEpoch > 0 && (endEpoch - currentEpoch) < threshold;
    });

    return { status: nearExpiry ? 'expiring' : 'active', deals };
  } catch (err) {
    return { status: 'error', deals: [], error: err.message };
  }
}

/**
 * Re-pin a CID by fetching its data from the IPFS gateway and
 * re-uploading to Lighthouse. This triggers a new storage deal.
 *
 * @param {string} cid
 * @param {string} apiKey Lighthouse API key
 * @param {object} [options]
 * @param {string} [options.gateway] IPFS gateway to fetch from
 * @returns {Promise<{success: boolean, newCid: string|null, error: string|null}>}
 */
async function repinCid(cid, apiKey, options) {
  const gateway = (options && options.gateway) || 'https://gateway.lighthouse.storage/ipfs';

  try {
    const url = `${gateway}/${cid}`;
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, newCid: null, error: `Gateway fetch failed: HTTP ${response.status}` };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const uploadResponse = await lighthouse.uploadBuffer(buffer, apiKey);
    if (!uploadResponse || !uploadResponse.data || !uploadResponse.data.Hash) {
      return { success: false, newCid: null, error: 'Lighthouse re-upload failed: unexpected response' };
    }

    return { success: true, newCid: uploadResponse.data.Hash, error: null };
  } catch (err) {
    return { success: false, newCid: null, error: err.message };
  }
}

module.exports = { checkDealStatus, repinCid, DEFAULT_EXPIRY_THRESHOLD_EPOCHS };
