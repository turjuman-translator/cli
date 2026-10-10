import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatIssues, ValidationError } from "../../src/validation.js";

function issuesOf(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return formatIssues(result.error);
}

describe("formatIssues", () => {
  it("writes one line per problem with its path, (root) for the whole value", () => {
    expect(issuesOf(z.string(), 5)).toEqual([
      "(root): Invalid input: expected string, received number",
    ]);
    const schema = z.object({ server: z.object({ ports: z.array(z.number()) }) });
    expect(issuesOf(schema, { server: { ports: [1, "x"] } })).toEqual([
      "server.ports.1: Invalid input: expected number, received string",
    ]);
  });

  it("names the unknown keys", () => {
    expect(issuesOf(z.strictObject({ a: z.number() }), { a: 1, b: 2, c: 3 })).toEqual([
      '(root): Unrecognized keys: "b", "c" (b, c)',
    ]);
  });

  it("gives the reason a record key is refused, not just that it is", () => {
    const schema = z.record(
      z
        .string()
        .regex(/^[a-z]+$/, "lowercase letters only")
        .max(3),
      z.number(),
    );
    expect(issuesOf(schema, { abc: 1, Ab: 2, abcd: 3 })).toEqual([
      "Ab: lowercase letters only",
      "abcd: Too big: expected string to have <=3 characters",
    ]);
  });
});

describe("ValidationError", () => {
  it("lists every problem, ready to print, and keeps them for callers", () => {
    const err = new ValidationError("Invalid config.yaml", ["server.port: too big", "(root): x"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("Invalid config.yaml:\n  - server.port: too big\n  - (root): x");
    expect(err.problems).toEqual(["server.port: too big", "(root): x"]);
  });
});
