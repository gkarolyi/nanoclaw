# Intent: Add Zulip channel import

Add `import './zulip.js';` to the channel barrel file so the Zulip
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
