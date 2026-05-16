import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { PrismaClient } from "@prisma/client";

// In Prisma 7, the client initialization may require adapter / accelerateUrl. 
// Assuming normal URL for local if not using adapter. But typical instantiation is empty since process.env is fine.
const db = new PrismaClient();

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "Personal Data Vault API",
          version: "1.0.0",
          description: "Zero-Knowledge Backend API for Personal Data Vault",
        },
      },
    })
  )
  .group("/api/v1", (app) =>
    app
      .get("/health", () => {
        return { status: "ok", timestamp: new Date().toISOString() };
      }, {
        detail: {
          summary: "Health Check",
          tags: ["System"]
        }
      })
      .post(
        "/users",
        async ({ body, set }) => {
          try {
            const user = await db.user.create({
              data: {
                username: body.username,
                publicKey: body.publicKey,
              },
            });
            set.status = 201;
            return { success: true, user: { id: user.id } };
          } catch (e: any) {
            set.status = 400;
            return { success: false, error: e.message };
          }
        },
        {
          body: t.Object({
            username: t.String(),
            publicKey: t.String(),
          }),
          detail: {
            summary: "Register new user (mock for Phase 1)",
            tags: ["Users"]
          }
        }
      )
  )
  .listen(3000);

console.log(
  `🦊 Personal Data Vault is running at ${app.server?.hostname}:${app.server?.port}`
);
