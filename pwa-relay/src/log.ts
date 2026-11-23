export type BridgeLogEvent =
  | { ev: "start"; port: number }
  | { ev: "host_connect"; hostId: string }
  | { ev: "host_reject"; code: number; reason: string }
  | { ev: "host_replaced"; hostId: string; abortedStreams: number }
  | { ev: "host_disconnect"; hostId: string; code: number; inFlight: number }
  | { ev: "stream_error"; status: number; reason: string }
  | { ev: "drain"; hostConnected: boolean; inFlight: number }
  | { ev: "stop" };

export type BridgeLogger = (event: BridgeLogEvent) => void;

export function createJsonLogger(write: (line: string) => void = (line) => process.stdout.write(line)): BridgeLogger {
  return (event) => {
    write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  };
}
