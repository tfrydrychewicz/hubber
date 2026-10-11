// One place for the address and the default ports, read by the server, the
// development runner, the Vite configuration and the end-to-end run.

// NFR-3: reachable from this machine only. A literal address, because the name
// "localhost" can resolve to ::1 first.
export const HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 4477;
export const DEFAULT_WEB_PORT = 5173;
// Not the default API port: the instance running there can hold real data.
export const DEFAULT_E2E_PORT = 4478;

export class PortError extends Error {
  override name = "PortError";
}

export function parsePort(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  // The pattern keeps out what Number() accepts but nobody means as a port: "0x1000", "1e4", " 5000".
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65_535) {
    throw new PortError(`Niepoprawna wartość ${variable}: "${raw}". Podaj numer portu od 1024 do 65535.`);
  }
  return port;
}
