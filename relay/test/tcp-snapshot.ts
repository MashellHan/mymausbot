import { spawnSync } from "node:child_process";

interface PortRange { first: number; last: number }

export function summarizeTcpState(output: string, destinationPort: number, range: PortRange | null) {
  const destination = `127.0.0.1.${destinationPort}`;
  const sourcePorts = new Set<number>();
  const clientStates: Record<string, number> = {};
  const serverStates: Record<string, number> = {};
  let listenerPresent = false;
  const sourcePort = (endpoint: string) => {
    if (!endpoint.startsWith("127.0.0.1.")) return null;
    const port = Number(endpoint.slice("127.0.0.1.".length));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  };
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== "tcp4" && columns[0] !== "tcp") continue;
    const [, , , local, foreign, state] = columns;
    if (!local || !foreign || !state) continue;
    if (local === destination && state === "LISTEN") listenerPresent = true;
    const clientSide = foreign === destination;
    const serverSide = local === destination && !clientSide;
    if (!clientSide && !serverSide) continue;
    const port = sourcePort(clientSide ? local : foreign);
    if (port === null) continue;
    sourcePorts.add(port);
    const states = clientSide ? clientStates : serverStates;
    const label = state.slice(0, 24);
    states[label] = (states[label] ?? 0) + 1;
  }
  const observedWithinRange = range === null ? null : [...sourcePorts].filter((port) => port >= range.first && port <= range.last).length;
  return {
    destinationPort, listenerPresent, clientStates, serverStates,
    sourcePortsObserved: sourcePorts.size,
    sourcePortRange: range,
    sourcePortsObservedWithinRange: observedWithinRange,
    sourcePortsUnobservedWithinRange: range === null || observedWithinRange === null ? null : range.last - range.first + 1 - observedWithinRange,
  };
}

export function captureTcpState(destinationPort: number) {
  if (process.platform !== "darwin") return { unavailable: "unsupported-platform" };
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
  const limits = spawnSync("/usr/sbin/sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"],
    { encoding: "utf8", env, timeout: 500, maxBuffer: 256 });
  const [first, last] = limits.status === 0 ? limits.stdout.trim().split(/\s+/).map(Number) : [];
  const range = first !== undefined && last !== undefined && Number.isInteger(first) && Number.isInteger(last)
    && first > 0 && last <= 65535 && first <= last ? { first, last } : null;
  const result = spawnSync("/usr/sbin/netstat", ["-an", "-p", "tcp"],
    { encoding: "utf8", env, timeout: 2_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return { unavailable: (result.error as NodeJS.ErrnoException | undefined)?.code ?? "netstat-exit" };
  return summarizeTcpState(result.stdout, destinationPort, range);
}
