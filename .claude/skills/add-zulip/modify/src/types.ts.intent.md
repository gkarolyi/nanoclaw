# Intent: Add Attachment interface to support file attachments

## Goal
Add the `Attachment` interface to `src/types.ts` to support file attachment metadata from messaging channels.

## Changes
- Add `Attachment` interface before `NewMessage` interface
- Add optional `attachments?: Attachment[]` field to `NewMessage` interface

## Invariants
- Must not modify any other interfaces
- Must maintain all existing interface fields
- Must be placed before `NewMessage` so it can be referenced

## Target Location
Insert the `Attachment` interface before the `NewMessage` interface definition.

## Code to Add

```typescript
export interface Attachment {
  filename: string;
  path: string; // Local filesystem path where file is stored
  url: string; // Original URL from the platform
  size?: number; // File size in bytes
  mimeType?: string;
}
```

Then add to `NewMessage`:
```typescript
  attachments?: Attachment[];
```

## Rationale
Channels like Zulip, WhatsApp, Telegram, etc. send file attachments that need to be downloaded and made available to the agent. This interface provides a standard way to represent attachment metadata across all channels.
