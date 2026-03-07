import WebSocket from 'ws';
import * as http from 'http';
import { CDP_URL } from '../config/config';

export interface CDPTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Chrome DevTools Protocol client for Cursor IDE
 * Connects to Cursor's remote debugging port and allows sending messages
 */
export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private reconnecting = false;

  /**
   * Check if CDP is available (Cursor running with --remote-debugging-port)
   */
  async isAvailable(): Promise<boolean> {
    try {
      const targets = await this.getTargets();
      return targets.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get available CDP targets (Cursor windows/pages)
   */
  async getTargets(): Promise<CDPTarget[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${CDP_URL}/json`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const targets = JSON.parse(data) as CDPTarget[];
            resolve(targets);
          } catch (err) {
            reject(new Error(`Failed to parse CDP targets: ${err}`));
          }
        });
      });
      req.on('error', (err) => {
        reject(new Error(`CDP not available: ${err.message}`));
      });
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('CDP connection timeout'));
      });
    });
  }

  /**
   * Connect to Cursor via CDP WebSocket
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    const targets = await this.getTargets();
    if (targets.length === 0) {
      throw new Error('No CDP targets available. Is Cursor running with --remote-debugging-port=9222?');
    }

    // Find the main Cursor window (usually the workbench)
    const target = targets.find(t => t.url.includes('workbench.html')) || targets[0];

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl);

      this.ws.on('open', async () => {
        console.log('[CDP] Connected to Cursor');
        // Enable required domains
        await this.sendCommand('Runtime.enable');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const pending = this.pendingRequests.get(msg.id)!;
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
          // Events (no id) are ignored for now
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on('error', (err) => {
        console.error('[CDP] WebSocket error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[CDP] Disconnected from Cursor');
        this.ws = null;
        this.pendingRequests.clear();
      });
    });
  }

  /**
   * Disconnect from CDP
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if connected to CDP
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a CDP command and wait for response
   */
  private async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    const id = this.msgId++;
    const msg = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`CDP command timeout: ${method}`));
        }
      }, 10000);
    });
  }

  /**
   * Evaluate JavaScript in the Cursor page context
   */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  /**
   * Send a message to Cursor's chat composer
   * 1. Focus the composer input
   * 2. Clear any existing text
   * 3. Insert the new message
   * 4. Press Enter to submit
   */
  async sendMessage(text: string): Promise<boolean> {
    if (!this.isConnected()) {
      await this.connect();
    }

    try {
      // Focus the composer input
      const focusResult = await this.evaluate(`
        (function() {
          const input = document.querySelector('.aislash-editor-input');
          if (!input) return { success: false, error: 'Composer input not found' };
          input.focus();
          // Select all to clear existing text
          const sel = window.getSelection();
          if (sel) sel.selectAllChildren(input);
          return { success: true };
        })()
      `) as { success: boolean; error?: string };

      if (!focusResult?.success) {
        console.error('[CDP] Failed to focus composer:', focusResult?.error);
        return false;
      }

      // Insert the text
      await this.sendCommand('Input.insertText', { text });

      // Press Enter to submit
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await this.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
      });

      console.log(`[CDP] Message sent: ${text.substring(0, 50)}...`);
      return true;
    } catch (err) {
      console.error('[CDP] Failed to send message:', err);
      return false;
    }
  }

  /**
   * Check if the composer panel is open
   */
  async isComposerOpen(): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      const result = await this.evaluate(`
        (function() {
          const input = document.querySelector('.aislash-editor-input');
          return input !== null;
        })()
      `);
      return result === true;
    } catch {
      return false;
    }
  }

  /**
   * Toggle the composer panel open/closed (Cmd+I)
   */
  async toggleComposer(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }

    // Simulate Cmd+I
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'i',
      code: 'KeyI',
      modifiers: 4, // Meta/Cmd
    });
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'i',
      code: 'KeyI',
    });
  }

  /**
   * Get the current Cursor window title (useful for detecting active project)
   */
  async getWindowTitle(): Promise<string | null> {
    try {
      const targets = await this.getTargets();
      const target = targets.find(t => t.url.includes('workbench.html'));
      return target?.title || null;
    } catch {
      return null;
    }
  }
}

// Singleton instance
let cdpClientInstance: CDPClient | null = null;

export function getCDPClient(): CDPClient {
  if (!cdpClientInstance) {
    cdpClientInstance = new CDPClient();
  }
  return cdpClientInstance;
}
