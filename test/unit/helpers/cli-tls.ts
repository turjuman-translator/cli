// Throwaway TLS certificates for the CLI tests, made with openssl like scripts/lan-cert.sh.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** openssl on PATH. */
export const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A self-signed certificate + key (P-256) naming `ips`, valid `days` days, as server.crt/.key. */
export function makeCert(dir: string, ips: string[], days = 400): { cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, "server.crt");
  const key = join(dir, "server.key");
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", key, "-out", cert, "-days", String(days), "-subj", "/CN=test"],
      ...["-addext", `subjectAltName=${ips.map((ip) => `IP:${ip}`).join(",")}`],
    ],
    { stdio: "ignore" },
  );
  return { cert, key };
}
