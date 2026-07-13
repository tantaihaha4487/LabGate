import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../lib/generated/prisma/client";

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL ?? "file:./data/labgate.db",
});
const db = new PrismaClient({ adapter });

async function main() {
  await db.machine.upsert({
    where: { webhookToken: "local-dev-machine-token-not-for-production" },
    update: {
      name: "Local Lab Machine",
      tailscaleIp: "100.64.0.10",
      status: "available",
      lastHeartbeat: new Date(),
    },
    create: {
      name: "Local Lab Machine",
      tailscaleIp: "100.64.0.10",
      webhookToken: "local-dev-machine-token-not-for-production",
      status: "available",
      lastHeartbeat: new Date(),
    },
  });
}

main()
  .then(() => db.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
