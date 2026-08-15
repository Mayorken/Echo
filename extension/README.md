# Echo Context Capture extension

Chrome Manifest V3 extension for syncing Claude and ChatGPT conversations to Echo.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `extension` folder.
4. Open the extension popup and enter the Echo account token and recovery key from Echo's Developer API connection panel.
5. Start with **Manual / review first**. Use the **Save to Echo** button inside a conversation.
6. When satisfied, choose **Automatic every 30 minutes**.

## Privacy behavior

- Automatic capture is disabled by default.
- Password-like values, common API keys, private keys, JWTs, and payment-card patterns are redacted locally.
- At most 40 recent messages are retained per captured conversation version.
- Duplicate snapshots are not uploaded.
- Echo keeps the 50 most recent conversation snapshots alongside the user's existing structured context.

Website DOM structures change over time. `content.js` keeps Claude and ChatGPT extraction isolated so adapters can be updated independently.
