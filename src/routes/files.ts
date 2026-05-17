import { Elysia, t } from "elysia";
import { auth, db } from "../auth";
import {
  initMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getObjectStream,
  deleteObject,
} from "../lib/storage";

async function requireSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

export const fileRoutes = new Elysia({ prefix: "/files" })

  /**
   * POST /files/upload/init
   *
   * E2EE Contract — client MUST perform these steps before calling:
   *   1. Generate a random AES-256-GCM key (DEK).
   *   2. Generate a random 12-byte IV.
   *   3. Encrypt the file with AES-256-GCM(DEK, IV) → ciphertext chunks.
   *   4. Encrypt DEK with the user's RSA public key (RSA-OAEP) → encryptedDek.
   *   5. Encrypt filename and MIME type with the same DEK/IV.
   *   6. Call this endpoint with the encrypted metadata only — plaintext never leaves the client.
   */
  .post(
    "/upload/init",
    async ({ request, body, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const storageKey = `${session.user.id}/${crypto.randomUUID()}`;
      const minioUploadId = await initMultipartUpload(storageKey);

      const uploadSession = await db.uploadSession.create({
        data: {
          ownerId: session.user.id,
          minioUploadId,
          storageKey,
          encryptedName: body.encryptedName,
          encryptedMime: body.encryptedMime,
          encryptedDek: body.encryptedDek,
          iv: body.iv,
          size: body.size,
          chunkCount: body.chunkCount,
          chunkSize: body.chunkSize,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return { fileId: uploadSession.id };
    },
    {
      body: t.Object({
        encryptedName: t.String({ description: "AES-256-GCM encrypted filename (Base64)" }),
        encryptedMime: t.String({ description: "AES-256-GCM encrypted MIME type (Base64)" }),
        encryptedDek: t.String({ description: "DEK encrypted with user RSA-OAEP public key (Base64)" }),
        iv: t.String({ description: "Base64-encoded 12-byte GCM initialization vector" }),
        size: t.Number({ description: "Total plaintext file size in bytes (max ~2GB)" }),
        chunkCount: t.Number({ description: "Total number of encrypted chunks" }),
        chunkSize: t.Number({ description: "Size of each chunk in bytes (last chunk may be smaller)" }),
      }),
      detail: {
        summary: "Initialize an E2EE file upload session",
        description:
          "Starts a MinIO multipart upload. The server never receives plaintext — " +
          "all encryption must happen client-side before calling this endpoint.",
        tags: ["Storage"],
      },
    }
  )

  /**
   * PUT /files/:fileId/chunks/:chunkIndex
   *
   * Upload a single pre-encrypted chunk. Body is raw binary (application/octet-stream).
   * chunkIndex is 1-based to match the MinIO/S3 multipart part numbering.
   * Returns the ETag which the client must collect and send to /complete.
   */
  .put(
    "/:fileId/chunks/:chunkIndex",
    async ({ request, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const uploadSession = await db.uploadSession.findUnique({
        where: { id: params.fileId },
      });

      if (!uploadSession || uploadSession.ownerId !== session.user.id) {
        set.status = 404;
        return { error: "Upload session not found" };
      }

      if (uploadSession.status !== "pending") {
        set.status = 400;
        return { error: "Upload session is no longer active" };
      }

      const chunkIndex = parseInt(params.chunkIndex, 10);
      if (isNaN(chunkIndex) || chunkIndex < 1 || chunkIndex > uploadSession.chunkCount) {
        set.status = 400;
        return { error: `Invalid chunk index: must be 1–${uploadSession.chunkCount}` };
      }

      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength === 0) {
        set.status = 400;
        return { error: "Chunk body is empty" };
      }

      const etag = await uploadPart(
        uploadSession.storageKey,
        uploadSession.minioUploadId,
        chunkIndex,
        new Uint8Array(rawBody)
      );

      return { chunkIndex, etag };
    },
    {
      params: t.Object({
        fileId: t.String(),
        chunkIndex: t.String({ description: "1-based chunk index" }),
      }),
      detail: {
        summary: "Upload an encrypted chunk",
        description:
          "Sends a single AES-256-GCM ciphertext chunk as raw binary. " +
          "Collect the returned ETag and pass all ETags to /complete.",
        tags: ["Storage"],
      },
    }
  )

  /**
   * POST /files/:fileId/complete
   *
   * Finalizes the MinIO multipart upload and promotes the upload session to a
   * persisted FileMetadata record. The parts array must include every ETag
   * returned during chunk uploads, in order.
   */
  .post(
    "/:fileId/complete",
    async ({ request, body, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const uploadSession = await db.uploadSession.findUnique({
        where: { id: params.fileId },
      });

      if (!uploadSession || uploadSession.ownerId !== session.user.id) {
        set.status = 404;
        return { error: "Upload session not found" };
      }

      if (uploadSession.status !== "pending") {
        set.status = 400;
        return { error: "Upload already finalized or aborted" };
      }

      const sortedParts = [...body.parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));

      await completeMultipartUpload(
        uploadSession.storageKey,
        uploadSession.minioUploadId,
        sortedParts
      );

      const [fileRecord] = await db.$transaction([
        db.fileMetadata.create({
          data: {
            id: uploadSession.id,
            ownerId: session.user.id,
            encryptedName: uploadSession.encryptedName,
            encryptedMime: uploadSession.encryptedMime,
            encryptedDek: uploadSession.encryptedDek,
            iv: uploadSession.iv,
            size: uploadSession.size,
            chunkCount: uploadSession.chunkCount,
            chunkSize: uploadSession.chunkSize,
            storageId: uploadSession.storageKey,
          },
        }),
        db.uploadSession.update({
          where: { id: params.fileId },
          data: { status: "complete" },
        }),
        db.auditLog.create({
          data: { fileId: uploadSession.id, userId: session.user.id, action: "FILE_UPLOAD" },
        }),
      ]);

      return { fileId: fileRecord.id };
    },
    {
      params: t.Object({ fileId: t.String() }),
      body: t.Object({
        parts: t.Array(
          t.Object({
            partNumber: t.Number({ description: "1-based part number matching the chunk index" }),
            etag: t.String({ description: "ETag returned by the chunk upload endpoint" }),
          }),
          { description: "All parts in any order; server sorts by partNumber before finalizing" }
        ),
      }),
      detail: {
        summary: "Finalize encrypted file upload",
        tags: ["Storage"],
      },
    }
  )

  /**
   * POST /files/:fileId/abort
   *
   * Cancels an in-progress upload and cleans up MinIO state.
   */
  .post(
    "/:fileId/abort",
    async ({ request, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const uploadSession = await db.uploadSession.findUnique({
        where: { id: params.fileId },
      });

      if (!uploadSession || uploadSession.ownerId !== session.user.id) {
        set.status = 404;
        return { error: "Upload session not found" };
      }

      if (uploadSession.status !== "pending") {
        set.status = 400;
        return { error: "Upload is not in pending state" };
      }

      await abortMultipartUpload(uploadSession.storageKey, uploadSession.minioUploadId);
      await db.uploadSession.update({
        where: { id: params.fileId },
        data: { status: "aborted" },
      });

      return { message: "Upload aborted" };
    },
    {
      params: t.Object({ fileId: t.String() }),
      detail: { summary: "Abort an in-progress upload", tags: ["Storage"] },
    }
  )

  /**
   * GET /files/:id
   *
   * Returns file metadata including the E2EE parameters the client needs to decrypt:
   * - encryptedDek: owner gets their DEK; shared users get their re-encrypted copy from SharePermission.
   * - iv: the GCM IV used during encryption.
   */
  .get(
    "/:id",
    async ({ request, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const file = await db.fileMetadata.findUnique({
        where: { id: params.id },
        include: { permissions: true },
      });

      if (!file) {
        set.status = 404;
        return { error: "File not found" };
      }

      const isOwner = file.ownerId === session.user.id;
      const sharePermission = file.permissions.find(
        (p) => p.userId === session.user.id && p.permissionType === "READ"
      );

      if (!isOwner && !sharePermission) {
        set.status = 403;
        return { error: "Forbidden" };
      }

      await db.auditLog.create({
        data: { fileId: file.id, userId: session.user.id, action: "FILE_METADATA_READ" },
      });

      return {
        id: file.id,
        encryptedName: file.encryptedName,
        encryptedMime: file.encryptedMime,
        // Owner gets their own encrypted DEK; shared users get their re-encrypted copy
        encryptedDek: isOwner ? file.encryptedDek : (sharePermission?.encryptedKey ?? null),
        iv: file.iv,
        size: file.size,
        chunkCount: file.chunkCount,
        chunkSize: file.chunkSize,
        createdAt: file.createdAt,
        access: isOwner ? "owner" : "shared",
      };
    },
    {
      detail: {
        summary: "Get file metadata and E2EE parameters",
        description:
          "Returns the encrypted DEK and IV needed for client-side decryption. " +
          "Owners receive their RSA-OAEP-wrapped DEK; shared users receive their re-encrypted copy.",
        tags: ["Storage"],
      },
    }
  )

  /**
   * GET /files/:id/stream
   *
   * Streams the raw ciphertext from MinIO. The client must first call GET /files/:id
   * to retrieve the encryptedDek and iv, decrypt the DEK locally using their private key,
   * then use DEK + iv to AES-256-GCM decrypt this stream.
   */
  .get(
    "/:id/stream",
    async ({ request, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const file = await db.fileMetadata.findUnique({
        where: { id: params.id },
        include: { permissions: true },
      });

      if (!file) {
        set.status = 404;
        return { error: "File not found" };
      }

      const isOwner = file.ownerId === session.user.id;
      const hasReadPermission = file.permissions.some(
        (p) => p.userId === session.user.id && p.permissionType === "READ"
      );

      if (!isOwner && !hasReadPermission) {
        set.status = 403;
        return { error: "Forbidden" };
      }

      const stream = await getObjectStream(file.storageId);

      await db.auditLog.create({
        data: { fileId: file.id, userId: session.user.id, action: "FILE_DOWNLOAD" },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${file.id}.enc"`,
          "Content-Length": String(file.size),
          "X-Chunk-Count": String(file.chunkCount),
          "X-Chunk-Size": String(file.chunkSize),
          "X-IV": file.iv,
        },
      });
    },
    {
      detail: {
        summary: "Stream download — raw ciphertext",
        description:
          "Returns the AES-256-GCM ciphertext stream. " +
          "Call GET /files/:id first to obtain encryptedDek and iv for client-side decryption.",
        tags: ["Storage"],
      },
    }
  )

  /**
   * DELETE /files/:id
   *
   * Deletes the file from MinIO and removes the FileMetadata record. Owner-only.
   */
  .delete(
    "/:id",
    async ({ request, params, set }) => {
      const session = await requireSession(request);
      if (!session?.user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const file = await db.fileMetadata.findUnique({ where: { id: params.id } });

      if (!file) {
        set.status = 404;
        return { error: "File not found" };
      }

      if (file.ownerId !== session.user.id) {
        set.status = 403;
        return { error: "Forbidden: only the owner can delete a file" };
      }

      // Audit before delete so the log entry briefly has a valid FK
      await db.auditLog.create({
        data: { fileId: file.id, userId: session.user.id, action: "FILE_DELETE" },
      });

      await Promise.all([
        deleteObject(file.storageId),
        db.fileMetadata.delete({ where: { id: params.id } }),
      ]);

      return { message: "File deleted" };
    },
    {
      detail: { summary: "Delete a file (owner only)", tags: ["Storage"] },
    }
  );
