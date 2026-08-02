import "dotenv/config";
import { defineConfig } from "prisma/config";
import { resolveDatabaseUrl } from "./src/lib/db-url";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  engine: "classic",
  datasource: {
    // Absolute, so the CLI and the running app agree on which file is the
    // database. See src/lib/db-url.ts.
    url: resolveDatabaseUrl(),
  },
});
