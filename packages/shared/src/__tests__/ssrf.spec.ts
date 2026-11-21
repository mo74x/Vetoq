import { describe, expect, it } from 'vitest';
import { isBlockedIpAddress, validateCallbackUrlSyntax } from '../ssrf.js';

describe('ssrf', () => {
  it('blocks private, loopback, and metadata IPv4/IPv6 ranges', () => {
    expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('10.0.0.5')).toBe(true);
    expect(isBlockedIpAddress('172.16.0.1')).toBe(true);
    expect(isBlockedIpAddress('192.168.1.10')).toBe(true);
    expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
    expect(isBlockedIpAddress('::1')).toBe(true);
    expect(isBlockedIpAddress('fc00::1')).toBe(true);
    expect(isBlockedIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('8.8.8.8')).toBe(false);
  });

  it('rejects localhost and internal hostnames in callback_url', () => {
    expect(validateCallbackUrlSyntax('http://localhost:5678/webhook').valid).toBe(false);
    expect(validateCallbackUrlSyntax('http://169.254.169.254/latest').valid).toBe(false);
    expect(validateCallbackUrlSyntax('ftp://example.com/hook').valid).toBe(false);
    expect(validateCallbackUrlSyntax('https://n8n.acme.com/webhook-waiting/123').valid).toBe(true);
  });
});
