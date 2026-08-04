import Privy, {
  LocalStorage,
  getEntropyDetailsFromUser,
  getUserEmbeddedEthereumWallet,
} from '@privy-io/js-sdk-core';
import { defineChain } from 'viem';

const filecoinCalibration = defineChain({
  id: 314159,
  name: 'Filecoin Calibration',
  nativeCurrency: { name: 'testnet Filecoin', symbol: 'tFIL', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://api.calibration.node.glif.io/rpc/v1'] },
  },
  blockExplorers: {
    default: { name: 'Filfox', url: 'https://calibration.filfox.info/en' },
  },
  testnet: true,
});

let client;
let user;
let provider;
let secureFrame;
let secureFrameReady;

function config() {
  return window.ECHO_CONFIG || {};
}

function isConfigured() {
  const { privyAppId, privyClientId } = config();
  return Boolean(privyAppId && privyClientId);
}

async function initialize() {
  if (!isConfigured()) return { configured: false, user: null };
  if (client) return { configured: true, user };

  const { privyAppId, privyClientId } = config();
  client = new Privy({
    appId: privyAppId,
    clientId: privyClientId,
    storage: new LocalStorage(),
    supportedChains: [filecoinCalibration],
  });
  await client.initialize();

  secureFrame = document.createElement('iframe');
  secureFrame.src = client.embeddedWallet.getURL();
  secureFrame.hidden = true;
  secureFrame.title = 'Echo secure wallet';
  secureFrameReady = new Promise((resolve) => {
    secureFrame.addEventListener('load', resolve, { once: true });
  });
  document.body.appendChild(secureFrame);
  client.setMessagePoster(secureFrame.contentWindow);
  window.addEventListener('message', (event) => {
    if (event.source !== secureFrame.contentWindow) return;
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    client.embeddedWallet.onMessage(data);
  });

  const params = new URLSearchParams(window.location.search);
  const oauthCode = params.get('privy_oauth_code');
  const oauthState = params.get('privy_oauth_state');
  if (oauthCode && oauthState) {
    const session = await client.auth.oauth.loginWithCode(oauthCode, oauthState);
    user = session.user;
    history.replaceState({}, document.title, window.location.pathname);
  } else {
    try {
      ({ user } = await client.user.get());
    } catch (error) {
      // A first-time visitor has no stored Privy session yet. The core SDK
      // reports that normal signed-out state as an error.
      if (!/no tokens found in storage/i.test(error && error.message ? error.message : String(error))) {
        throw error;
      }
      user = null;
    }
  }
  return { configured: true, user };
}

async function signInWithGoogle() {
  await initialize();
  if (!client) throw new Error('Google sign-in is not configured');
  const redirectURI = `${window.location.origin}${window.location.pathname}`;
  const oauthResult = await client.auth.oauth.generateURL('google', redirectURI);
  const oauthURL = typeof oauthResult === 'string' ? oauthResult : oauthResult.url;
  if (!oauthURL) throw new Error('Privy did not return a Google sign-in URL');
  window.location.assign(oauthURL);
}

async function getWalletSession() {
  await initialize();
  if (!user) return null;
  let wallet = getUserEmbeddedEthereumWallet(user);
  if (!wallet) {
    ({ user } = await client.embeddedWallet.create({}));
    wallet = getUserEmbeddedEthereumWallet(user);
  }
  if (!wallet) throw new Error('Unable to create your secure Echo account');

  if (!provider) {
    await secureFrameReady;
    const { entropyId, entropyIdVerifier } = getEntropyDetailsFromUser(user);
    provider = await client.embeddedWallet.getEthereumProvider({
      wallet,
      entropyId,
      entropyIdVerifier,
    });
  }
  return {
    address: wallet.address,
    provider,
    user,
    accessToken: await client.getAccessToken(),
  };
}

async function signOut() {
  if (!client || !user) return;
  await client.auth.logout({ userId: user.id });
  user = null;
  provider = null;
}

window.EchoPrivy = {
  initialize,
  isConfigured,
  signInWithGoogle,
  getWalletSession,
  signOut,
};
