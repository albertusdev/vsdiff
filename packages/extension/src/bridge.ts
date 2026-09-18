import { chmodSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { createBridgeServer } from './bridge-server.ts';

// Dev-only test control. Off unless VSDIFF_DEV_BRIDGE=1; binds 127.0.0.1
// on an ephemeral port and writes {port, pid, token} to VSDIFF_DEV_BRIDGE_FILE so the
// harness can find it.
export function startBridge(getState: () => unknown): vscode.Disposable | undefined {
  if (process.env['VSDIFF_DEV_BRIDGE'] !== '1') {
    return undefined;
  }
  const bridgeFile = process.env['VSDIFF_DEV_BRIDGE_FILE'];
  if (!bridgeFile) {
    console.warn('[vsdiff] VSDIFF_DEV_BRIDGE=1 but VSDIFF_DEV_BRIDGE_FILE unset; bridge disabled');
    return undefined;
  }

  const { server, token } = createBridgeServer(getState, (command, ...args) =>
    vscode.commands.executeCommand(command, ...args),
  );

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') {
      writeFileSync(
        bridgeFile,
        JSON.stringify({
          port: address.port,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      chmodSync(bridgeFile, 0o600);
      console.log(`[vsdiff] dev bridge on 127.0.0.1:${address.port} → ${bridgeFile}`);
    }
  });

  return new vscode.Disposable(() => server.close());
}
