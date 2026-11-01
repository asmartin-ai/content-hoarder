import * as config from "../src/config.ts";
import * as db from "../src/db.ts";
import { createInvite, hostedOrigin } from "../src/hosted.ts";

function main(): void {
  config.loadEnv();
  const origin = hostedOrigin();

  if (!origin) {
    console.error(
      "CONTENT_HOARDER_PUBLIC_ORIGIN is not set; invites only work on a hosted instance.",
    );
    process.exit(1);
  }

  const connection = db.connect(config.dbPath());

  try {
    console.log(`${origin}/invite/${createInvite(connection)}`);
  } finally {
    connection.close();
  }
}

main();
