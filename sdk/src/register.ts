/**
 * Device registration flow.
 *
 * Implements the device authorization flow (similar to GitHub CLI):
 * 1. Request a verification code from the server
 * 2. Display URL for user to open in browser
 * 3. Poll until user completes verification
 * 4. Return device ID and refresh token
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface RegistrationResult {
  deviceId: string;
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
}

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

function httpRequest(
  url: string,
  method: string,
  body?: object
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode || 0, data: {} });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Request a device verification code from the server.
 *
 * @param serverUrl - CmdCtrl server URL (e.g., "https://app.cmd-ctrl.ai")
 * @param deviceName - Human-readable device name (e.g., "Work Laptop")
 * @param hostname - Machine hostname
 * @param agentType - Your agent type identifier (e.g., "my_agent")
 * @returns Device code response with verification URL
 */
export async function requestDeviceCode(
  serverUrl: string,
  deviceName: string,
  hostname: string,
  agentType: string
): Promise<DeviceCodeResponse> {
  const res = await httpRequest(`${serverUrl}/api/devices/code`, 'POST', {
    deviceName,
    hostname,
    agentType,
  });

  if (res.status !== 200) {
    throw new Error(`Failed to get device code: ${res.data?.error || res.data?.message || `HTTP ${res.status}`}`);
  }

  return res.data as DeviceCodeResponse;
}

/**
 * Poll for token after user completes verification.
 *
 * @param serverUrl - CmdCtrl server URL
 * @param deviceCode - Device code from requestDeviceCode()
 * @param interval - Poll interval in seconds
 * @param expiresIn - Code expiration in seconds
 * @param onPoll - Optional callback on each poll attempt (for progress display)
 * @returns Registration result with device ID and tokens, or null if expired
 */
export async function pollForToken(
  serverUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  onPoll?: () => void
): Promise<RegistrationResult | null> {
  const expiresAt = Date.now() + expiresIn * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));

    if (onPoll) onPoll();

    try {
      const res = await httpRequest(`${serverUrl}/api/devices/token`, 'POST', { deviceCode });

      if (res.status === 200) {
        return {
          deviceId: res.data.deviceId,
          refreshToken: res.data.refreshToken,
          accessToken: res.data.accessToken,
          expiresIn: res.data.expiresIn,
        };
      }

      if (res.status === 400 && res.data.error === 'authorization_pending') {
        continue;
      }

      throw new Error(`Unexpected response: ${res.data?.error || res.data?.message || `HTTP ${res.status}`}`);
    } catch (err) {
      if ((err as Error).message?.startsWith('Unexpected response')) throw err;
      // Network error — keep polling
    }
  }

  return null; // Expired
}

/**
 * Complete device registration flow.
 *
 * Convenience function that combines requestDeviceCode and pollForToken.
 *
 * @param serverUrl - CmdCtrl server URL
 * @param deviceName - Human-readable device name
 * @param hostname - Machine hostname
 * @param agentType - Your agent type identifier
 * @param onVerificationUrl - Callback with the URL the user should open
 * @returns Registration result, or null if verification expired
 */
export async function registerDevice(
  serverUrl: string,
  deviceName: string,
  hostname: string,
  agentType: string,
  onVerificationUrl: (url: string, userCode: string) => void
): Promise<RegistrationResult | null> {
  const codeResponse = await requestDeviceCode(serverUrl, deviceName, hostname, agentType);

  onVerificationUrl(codeResponse.verificationUrl, codeResponse.userCode);

  return pollForToken(
    serverUrl,
    codeResponse.deviceCode,
    codeResponse.interval,
    codeResponse.expiresIn,
    () => process.stdout.write('.')
  );
}

/**
 * Unregister a device from the server.
 *
 * Calls DELETE /api/devices/{deviceId} with the device's refresh token.
 * Returns true if the device was removed (or was already gone), false on error.
 *
 * @param serverUrl - CmdCtrl server URL
 * @param deviceId - Device ID to unregister
 * @param refreshToken - Device refresh token for authentication
 */
export async function unregisterDevice(
  serverUrl: string,
  deviceId: string,
  refreshToken: string
): Promise<boolean> {
  try {
    const parsed = new URL(`${serverUrl}/api/devices/${deviceId}`);
    const client = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${refreshToken}` },
      }, (res) => {
        // Consume response body
        res.on('data', () => {});
        res.on('end', () => {
          resolve(res.statusCode === 204 || res.statusCode === 200 || res.statusCode === 404);
        });
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}
