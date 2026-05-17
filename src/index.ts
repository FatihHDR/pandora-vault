import { Elysia } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { auth } from "./auth";
import { ensureBucketExists } from "./lib/storage";
import { fileRoutes } from "./routes/files";

await ensureBucketExists();

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "Pandora Vault API",
          version: "3.0.0",
          description:
            "Zero-Knowledge Personal Data Vault — Phase 3: E2EE Storage with MinIO + Better Auth",
        },
        tags: [
          { name: "Health", description: "Service health" },
          { name: "Auth", description: "Better Auth endpoints" },
          { name: "Storage", description: "E2EE file upload, download, and management" },
        ],
      },
    })
  )
  .group("/api/v1", (app) =>
    app
      .get(
        "/health",
        () => ({ status: "ok", phase: 3, auth: "better-auth", storage: "minio-e2ee" }),
        { detail: { summary: "Health check", tags: ["Health"] } }
      )
      .all("/auth/*", ({ request }) => auth.handler(request), {
        detail: { summary: "Better Auth handler", tags: ["Auth"] },
      })
      .use(fileRoutes)
  )
  .listen(3000);

console.log(
  `Pandora Vault (Phase 3 — E2EE Storage) running at ${app.server?.hostname}:${app.server?.port}`
);
