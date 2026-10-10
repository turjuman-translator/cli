// Download the Tanzil Quran text and the configured translations into DATA_DIR/quran/ by hand.
// The server already does this by itself when the files are missing (src/quran/tanzil.ts); this
// script is for downloading again, for extra translations and for commercial use.
//
//   pnpm exec tsx scripts/quran-data.ts                                 # what is missing
//   pnpm exec tsx scripts/quran-data.ts --trans nl.leemhuis,nl.keyzer    # + extra translations
//   pnpm exec tsx scripts/quran-data.ts --force                         # download again
//   pnpm exec tsx scripts/quran-data.ts --commercial                    # no translations (their terms)
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { downloadQuranData, TEXT_TERMS, TRANS_TERMS } from "../src/quran/tanzil.js";

const USAGE =
  "usage: quran-data [--force] [--commercial] [--trans id1,id2]  (ids like nl.leemhuis)";

async function main(): Promise<number> {
  let values: { force: boolean; commercial: boolean; trans: string[]; help: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        force: { type: "boolean", default: false },
        commercial: { type: "boolean", default: false },
        trans: { type: "string", multiple: true, default: [] },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { paths } = loadConfig();
  console.log("Tanzil Quran text, Terms of Use (https://tanzil.net/docs/Text_License):");
  console.log(`  ${TEXT_TERMS}`);
  console.log("Translations, Terms of Use (https://tanzil.net/trans/):");
  console.log(`  ${TRANS_TERMS}`);
  console.log("Downloading implies agreeing to these terms. The files are stored verbatim.\n");
  const result = await downloadQuranData({
    files: paths,
    force: values.force,
    commercial: values.commercial,
    extra: values.trans.flatMap((v) => v.split(",")).filter((id) => id !== ""),
    progress: (line) => console.log(line),
  });
  for (const steps of result.manual) console.log(`\n${steps}`);
  if (result.licenseFile !== null) console.log(`\nsaved ${result.licenseFile}`);
  if (result.failed.length > 0) {
    console.error(`\n${result.failed.length} file(s) failed: see the manual steps above.`);
    return 1;
  }
  console.log("\nDone. Credit Tanzil (https://tanzil.net) wherever verse text is shown.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
