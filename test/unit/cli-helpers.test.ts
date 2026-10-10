import { afterEach, describe, expect, it } from "vitest";
import { mergeEnv } from "../../src/cli/env-file.js";
import { lanCertCmd } from "../../src/cli/hint.js";
import { lanAddress, serverAddresses } from "../../src/cli/urls.js";
import { parseErrorText } from "../../src/cli/usage.js";
import { configured, removeTempDirs } from "./helpers/cli-env.js";

afterEach(() => {
  removeTempDirs();
});

describe("mergeEnv, edge cases", () => {
  it("ends a quote that never closes at its own line, like Node's parser", () => {
    expect(mergeEnv('A="never closed\nB=2\n', { B: "3" })).toBe('A="never closed\nB=3\n');
  });

  it("gives an empty file for no lines and no updates", () => {
    expect(mergeEnv("", {})).toBe("");
  });
});

describe("lanCertCmd", () => {
  it("names the working folder as . when the certificate lives right there", () => {
    expect(lanCertCmd("/srv/turjuman/server.crt", false, "/srv/turjuman")).toBe(
      "bash scripts/lan-cert.sh .",
    );
  });
});

describe("parseErrorText", () => {
  it("adds a full stop only when the message has none", () => {
    expect(parseErrorText(new Error("Option '--out <value>' argument missing"))).toBe(
      "Option '--out <value>' argument missing.",
    );
    expect(
      parseErrorText(new Error("Unknown option '--x'. To specify a positional argument, use '--'")),
    ).toBe("Unknown option '--x'.");
    expect(parseErrorText(new Error("Already a sentence."))).toBe("Already a sentence.");
  });
});

describe("addresses, edge cases", () => {
  it("skips network interfaces without addresses", () => {
    expect(lanAddress({ lo0: undefined })).toBeNull();
    expect(
      lanAddress({
        lo0: undefined,
        en0: [
          {
            address: "fe80::1",
            family: "IPv6",
            internal: false,
            netmask: "",
            mac: "",
            cidr: null,
            scopeid: 0,
          },
          {
            address: "172.20.0.5",
            family: "IPv4",
            internal: false,
            netmask: "",
            mac: "",
            cidr: null,
          },
        ],
      }),
    ).toBe("172.20.0.5");
  });

  it("has no LAN address for a lan server that listens on loopback only", () => {
    const { loaded } = configured("server:\n  host: 127.0.0.1\n  exposure: lan\n  port: 8801\n");
    expect(serverAddresses(loaded).lan).toBeNull();
  });
});
