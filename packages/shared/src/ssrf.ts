import ipaddr from 'ipaddr.js';

const BLOCKED_IP_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'reserved',
  'uniqueLocal',
  'carrierGradeNat',
  'ipv4Mapped',
]);

export function isBlockedIpAddress(ip: string): boolean {
  try {
    let parsed = ipaddr.parse(ip);
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        parsed = v6.toIPv4Address();
      }
    }
    return BLOCKED_IP_RANGES.has(parsed.range());
  } catch {
    return true;
  }
}

export function validateCallbackUrlSyntax(rawUrl: string): { valid: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid callback_url' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { valid: false, reason: 'callback_url must use http or https' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, reason: 'callback_url hostname is not allowed' };
  }

  if (ipaddr.isValid(hostname) && isBlockedIpAddress(hostname)) {
    return { valid: false, reason: 'callback_url IP address is in a blocked range' };
  }

  return { valid: true };
}
