import { describe, expect, it } from "vitest";
import { inContainer, lanCertCmd, quranDataCmd, turjumanCmd } from "../../src/cli/hint.js";

describe("hints for where Turjuman runs (checkout or Docker image)", () => {
  it("knows the Docker image by CAPTIONS_CONTAINER=1", () => {
    expect(inContainer({ CAPTIONS_CONTAINER: "1" })).toBe(true);
    expect(inContainer({})).toBe(false);
  });

  it("runs the CLI through pnpm in a checkout", () => {
    expect(turjumanCmd("screens enable abc", false)).toBe("pnpm turjuman screens enable abc");
    expect(quranDataCmd(false)).toBe("pnpm exec tsx scripts/quran-data.ts");
  });

  it("gives the make target in the Docker image, else make cli", () => {
    expect(turjumanCmd("setup", true)).toBe("make keys");
    expect(turjumanCmd("screens list", true)).toBe("make screens");
    expect(turjumanCmd("users add <name> --admin", true)).toBe(
      "make user-add USERNAME=<name> ADMIN=1",
    );
    expect(turjumanCmd("screens enable abc", true)).toBe("make cli ARGS='screens enable abc'");
    expect(quranDataCmd(true)).toBe("make quran-data");
  });

  it("makes the LAN certificate where the config expects it", () => {
    expect(lanCertCmd("/srv/turjuman/tls/server.crt", false, "/srv/turjuman")).toBe(
      "bash scripts/lan-cert.sh tls",
    );
    expect(lanCertCmd("/etc/turjuman/tls/server.crt", false, "/srv/turjuman")).toBe(
      "bash scripts/lan-cert.sh /etc/turjuman/tls",
    );
    expect(lanCertCmd("/srv/my config/tls/server.crt", false, "/srv")).toBe(
      'bash scripts/lan-cert.sh "my config/tls"',
    );
    expect(lanCertCmd("/app/config/tls/server.crt", true)).toBe("make lan-cert");
  });
});
