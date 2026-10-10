import type { z } from "zod";

/** Turn zod issues into one readable line each: `path.to.field: message`. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
    // A record key that fails its own schema: zod nests the reason under "Invalid key in record".
    const message =
      issue.code === "invalid_key" ? issue.issues.map((i) => i.message).join("; ") : issue.message;
    return `${path === "" ? "(root)" : path}: ${message}${keys}`;
  });
}

/** A validation failure with every problem listed, ready to print. */
export class ValidationError extends Error {
  readonly problems: string[];

  constructor(subject: string, problems: string[]) {
    super(`${subject}:\n  - ${problems.join("\n  - ")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}
