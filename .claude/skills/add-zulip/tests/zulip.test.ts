import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('zulip skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: zulip');
    expect(content).toContain('version: 1.0.0');
  });

  it('has all files declared in adds', () => {
    const channelFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'zulip.ts',
    );
    expect(fs.existsSync(channelFile)).toBe(true);

    const content = fs.readFileSync(channelFile, 'utf-8');
    expect(content).toContain('class ZulipChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain("registerChannel('zulip'");

    const testFile = path.join(
      skillDir,
      'add',
      'src',
      'channels',
      'zulip.test.ts',
    );
    expect(fs.existsSync(testFile)).toBe(true);

    const testContent = fs.readFileSync(testFile, 'utf-8');
    expect(testContent).toContain("describe('ZulipChannel'");
  });

  it('has all files declared in modifies', () => {
    const modifyFiles = [
      path.join(skillDir, 'modify', 'src', 'channels', 'index.ts'),
      path.join(skillDir, 'modify', 'src', 'container-runner.ts'),
      path.join(skillDir, 'modify', 'src', 'types.ts'),
      path.join(skillDir, 'modify', 'src', 'db.ts'),
      path.join(skillDir, 'modify', 'src', 'db.test.ts'),
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'index.ts'),
      path.join(
        skillDir,
        'modify',
        'container',
        'agent-runner',
        'src',
        'ipc-mcp-stdio.ts',
      ),
      path.join(skillDir, 'modify', '.env.example'),
    ];
    for (const file of modifyFiles) {
      expect(fs.existsSync(file)).toBe(true);
    }

    const indexContent = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'index.ts'),
      'utf-8',
    );
    expect(indexContent).toContain("import './zulip.js'");

    const envContent = fs.readFileSync(
      path.join(skillDir, 'modify', '.env.example'),
      'utf-8',
    );
    expect(envContent).toContain('ZULIP_SITE');
    expect(envContent).toContain('ZULIP_EMAIL');
    expect(envContent).toContain('ZULIP_API_KEY');
  });

  it('has intent files for modified files', () => {
    expect(
      fs.existsSync(
        path.join(skillDir, 'modify', 'src', 'channels', 'index.ts.intent.md'),
      ),
    ).toBe(true);
  });
});
