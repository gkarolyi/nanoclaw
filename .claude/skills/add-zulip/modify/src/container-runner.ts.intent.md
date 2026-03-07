# Intent: Add uploads directory mount for channel attachments

## Goal
Mount a shared `data/uploads/` directory into all containers at `/workspace/uploads/` so that file attachments downloaded by channels on the host are accessible to agents in containers.

## Changes
Add a new mount entry in the `buildVolumeMounts()` function to mount the uploads directory.

## Invariants
- Must be added after the IPC mount setup (after line creating `groupIpcDir`)
- Must be read-only to prevent agents from modifying/deleting uploads
- Must create the directory if it doesn't exist
- Must not interfere with existing mounts

## Target Location
In `src/container-runner.ts`, in the `buildVolumeMounts()` function, after the IPC mount block (around the line with `containerPath: '/workspace/ipc'`), insert the uploads mount.

## Code to Add

```typescript
  // Shared uploads directory for file attachments from channels
  const uploadsDir = path.join(projectRoot, 'data', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  mounts.push({
    hostPath: uploadsDir,
    containerPath: '/workspace/uploads',
    readonly: true, // Agent can read but not modify/delete uploads
  });
```

## Rationale
Channels (WhatsApp, Zulip, Telegram, etc.) run on the host and receive file attachments. These files need to be stored on the host filesystem but accessible to agents running in containers. By mounting `data/uploads/` as `/workspace/uploads/`, channels can download files to the host path and agents can read them from the container path.
