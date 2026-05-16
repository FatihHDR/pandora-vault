import { Elysia, t } from "elysia";
import { swagger } from "@elysiajs/swagger";
import { auth, db } from "./auth";

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "Personal Data Vault API",
          version: "1.0.0",
          description: "Zero-Knowledge Backend API - Phase 2: with Better Auth & RBAC",
        },
      },
    })
  )
  .group("/api/v1", (app) =>
    app
      .get("/health", () => {
        return { status: "ok", phase: 2, auth: "better-auth" };
      })
      
      // Mount better-auth handler for /api/auth routes
      .all("/auth/*", ({ request }) => {
        return auth.handler(request);
      })

      // Granular Access Control RBAC example
      .get("/files/:id", async ({ request, params: { id }, set }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session || !session.user) {
          set.status = 401;
          return { error: "Unauthorized" };
        }
        
        const file = await db.fileMetadata.findUnique({ 
          where: { id },
          include: { permissions: true }
        });
        
        if (!file) {
          set.status = 404;
          return { error: "File not found" };
        }

        const isOwner = file.ownerId === session.user.id;
        const hasPermission = file.permissions.some(p => p.userId === session.user.id && p.permissionType === "READ");
        
        if (!isOwner && !hasPermission) {
          set.status = 403;
          return { error: "Forbidden: You don't have access to this file." };
        }

        return { 
          metadata: file,
          message: isOwner ? "Granted access as owner" : "Granted access via share permission" 
        };
      }, {
        detail: { summary: "Get file metadata (Requires Auth and Permissions)", tags: ["Storage"] }
      })
  )
  .listen(3000);

console.log(
  `🦊 Personal Data Vault (Phase 2 w/ Better Auth) is running at ${app.server?.hostname}:${app.server?.port}`
);
