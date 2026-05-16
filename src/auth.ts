import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { passkey } from "better-auth/plugins/passkey";
import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(db, {
    provider: "postgresql",
  }),
  plugins: [
    passkey(),
  ],
  advanced: {
    generateId: false, // Let Prisma handle defaults where needed, or adapt depending on need
  }
});
