import WebSocket from 'ws';
import * as http from 'http';
import { CDP_URL } from '../config/config';

export interface CDPTarget {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

/**
 * Chrome DevTools Protocol client for VS Code
 * Connects to VS Code's remote debugging port and allows sending messages to Copilot Chat
 */
export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();

  /**
   * Check if CDP is available (VS Code running with --remote-debugging-port)
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
   * Get available CDP targets (VS Code windows/pages)
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
   * Connect to VS Code via CDP WebSocket
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    const targets = await this.getTargets();
    if (targets.length === 0) {
      throw new Error('No CDP targets available. Is VS Code running with --remote-debugging-port=9223?');
    }

    // Find the main VS Code window (workbench)
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench.html')) ||
                   targets.find(t => t.type === 'page') ||
                   targets[0];

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl);

      this.ws.on('open', async () => {
        console.log('[CDP] Connected to VS Code');
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
        console.log('[CDP] Disconnected from VS Code');
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
   * Evaluate JavaScript in the VS Code page context
   */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    return result?.result?.value;
  }

  /**
   * Check if Copilot Chat panel is open
   */
  async isChatOpen(): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      const result = await this.evaluate(`
        (function() {
          const inputEditor = document.querySelector('.interactive-input-editor');
          return inputEditor !== null;
        })()
      `);
      return result === true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message to VS Code's Copilot Chat
   * 1. Click on the chat input to focus it
   * 2. Triple-click to select all existing text
   * 3. Insert the new message (replaces selected text)
   * 4. Press Enter to submit
   */
  async sendMessage(text: string): Promise<boolean> {
    if (!this.isConnected()) {
      await this.connect();
    }

    try {
      // Step 1: Get the chat input position and click on it
      const pos = await this.evaluate(`
        (function() {
          const chatEditor = document.querySelector('.interactive-input-editor');
          if (!chatEditor) return { success: false, error: 'Chat panel not open' };

          const rect = chatEditor.getBoundingClientRect();
          return {
            success: true,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        })()
      `) as { success: boolean; error?: string; x?: number; y?: number };

      if (!pos?.success) {
        console.error('[CDP] Failed to find chat input:', pos?.error);
        return false;
      }

      // Step 2: Triple-click to select all text in the input
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: pos.x,
        y: pos.y,
        button: 'left',
        clickCount: 3,
      });
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: pos.x,
        y: pos.y,
        button: 'left',
        clickCount: 3,
      });

      await this.delay(100);

      // Step 3: Insert the text (replaces any selected text)
      await this.sendCommand('Input.insertText', { text });

      await this.delay(100);

      // Step 4: Press Enter to submit
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

      // Scroll chat to bottom so VS Code renders the streaming response.
      // CDP-injected keypresses don't trigger VS Code's native "scroll to bottom on submit"
      // logic, so Copilot's response won't appear until the next user action without this.
      await this.delay(300);
      await this.evaluate(`
        (function() {
          const selectors = [
            '.chat-list-renderer',
            '.interactive-list .monaco-list',
            '.interactive-session .monaco-scrollable-element',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { el.scrollTop = el.scrollHeight; break; }
          }
        })()
      `);

      console.log(`[CDP] Message sent: ${text.substring(0, 50)}...`);
      return true;
    } catch (err) {
      console.error('[CDP] Failed to send message:', err);
      return false;
    }
  }

  /**
   * Get the current VS Code window title (useful for detecting active project)
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

  /**
   * Open the Copilot Chat panel (Cmd+Shift+I on macOS)
   */
  async openChatPanel(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }

    // Cmd+Shift+I on macOS, Ctrl+Shift+I on others
    const modifier = process.platform === 'darwin' ? 5 : 3; // 5 = Meta+Shift, 3 = Ctrl+Shift
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'i',
      code: 'KeyI',
      modifiers: modifier,
    });
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'i',
      code: 'KeyI',
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
