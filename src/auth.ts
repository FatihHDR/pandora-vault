import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(db, {
    provider: "postgresql",
  }),
});
