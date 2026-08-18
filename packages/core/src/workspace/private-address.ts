/** Hostnames that name the local machine without being address literals. */
const LOCAL_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::", "::1"]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/**
 * Whether a hostname names the machine itself or an address only reachable from its network.
 *
 * Used to decide what a probe will follow rather than what it will contact: an address the user
 * configured is one their agent application already dials, but an address a remote server names in
 * a redirect is chosen by that server at probe time, and reaching it is a capability the
 * configuration never granted.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (LOCAL_HOSTNAMES.has(host) || host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  const octets = ipv4Octets(host);
  return octets === undefined ? isPrivateIpv6(host) : isPrivateIpv4(octets);
}

function ipv4Octets(host: string): readonly number[] | undefined {
  const match = IPV4_PATTERN.exec(host);
  if (match === null) {
    return undefined;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

// fallow-ignore-next-line complexity -- one reserved IPv4 range per branch, flattest as a list.
function isPrivateIpv4(octets: readonly number[]): boolean {
  const [first = 0, second = 0] = octets;
  return (
    first === 0 || // "this network"
    first === 10 ||
    first === 127 || // loopback
    (first === 100 && second >= 64 && second <= 127) || // carrier-grade NAT
    (first === 169 && second === 254) || // link-local, including cloud metadata
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) || // benchmarking
    first >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) {
    return false;
  }
  // `::ffff:127.0.0.1` and friends carry an IPv4 address in the last group.
  const trailing = host.slice(host.lastIndexOf(":") + 1);
  const embedded = ipv4Octets(trailing);
  if (embedded !== undefined) {
    return isPrivateIpv4(embedded);
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]|^fe[89ab]/u.test(host);
}
