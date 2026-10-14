import { createHash, randomUUID } from "node:crypto";
import sql from "mssql";
import { renderSignaturePng } from "./signature.js";

const binaryHash = (content) => createHash("sha256").update(content).digest();

function mapDelivery(row) {
  return {
    id: String(row.EntregaId),
    assignmentId: String(row.AsignacionId),
    clientId: String(row.ClienteId),
    clientName: row.ClienteNombreSnapshot,
    clientRfc: row.ClienteRfcSnapshot,
    scheduledAmount: Number(row.ImporteProgramado),
    deliveredAmount:
      row.ImporteEntregado === null || row.ImporteEntregado === undefined
        ? null
        : Number(row.ImporteEntregado),
    returnAmount: Number(row.ImporteProgramado) - Number(row.ImporteEntregado ?? 0),
    receiverName: row.ReceptorNombre ?? null,
    status: row.Estado,
    issueReason: row.Motivo ?? null,
    observations: row.Observaciones ?? null,
    createdAt: row.FechaCreacionUtc,
    completedAt: row.FechaConfirmacionUtc ?? null,
    eventAt: row.FechaEventoUtc ?? null,
  };
}

function mapSummary(row) {
  return {
    assignedAmount: Number(row.TotalProgramado ?? 0),
    deliveredAmount: Number(row.TotalEntregado ?? 0),
    returnAmount: Number(row.TotalProgramado ?? 0) - Number(row.TotalEntregado ?? 0),
    totalDeliveries: Number(row.TotalEntregas ?? 0),
    pendingDeliveries: Number(row.Pendientes ?? 0),
    completedDeliveries: Number(row.Entregadas ?? 0),
    issueDeliveries: Number(row.Incidencias ?? 0),
  };
}

function toBase64(value) {
  if (!value) return null;
  return Buffer.from(value).toString("base64");
}

function toHex(value) {
  if (!value) return null;
  return Buffer.from(value).toString("hex");
}

function mapDeliveryDetail(row) {
  const delivery = mapDelivery(row);
  return {
    ...delivery,
    signature: row.FirmaContenido
      ? {
          mimeType: row.FirmaMimeType ?? "image/png",
          base64: toBase64(row.FirmaContenido),
          hashSha256: toHex(row.FirmaHashSha256),
        }
      : null,
    video: row.VideoId
      ? {
          id: String(row.VideoId),
          extension: row.VideoExtension ?? null,
          mimeType: row.VideoMimeType ?? null,
          sizeBytes:
            row.VideoTamanoBytes === null || row.VideoTamanoBytes === undefined
              ? null
              : Number(row.VideoTamanoBytes),
          hashSha256: toHex(row.VideoHashSha256),
        }
      : null,
  };
}

export function createDeliveryRepository(database) {
  const baseSelect = `
    SELECT e.EntregaId, e.AsignacionId, e.ClienteId, e.ClienteNombreSnapshot,
      e.ClienteRfcSnapshot, e.ImporteProgramado, e.Observaciones,
      e.FechaCreacionUtc, d.ImporteEntregado, d.ReceptorNombre,
      d.FechaConfirmacionUtc, ev.Motivo, ev.FechaEventoUtc,
      CASE
        WHEN d.EntregaDetalleId IS NOT NULL THEN 'ENTREGADA'
        WHEN ev.EntregaEventoId IS NOT NULL THEN ev.TipoEvento
        ELSE 'PENDIENTE'
      END AS Estado
    FROM efectivo.entregas e
    JOIN efectivo.asignaciones a ON a.AsignacionId = e.AsignacionId
    LEFT JOIN efectivo.entregas_detalle d ON d.EntregaId = e.EntregaId
    OUTER APPLY (
      SELECT TOP (1) ee.EntregaEventoId, ee.TipoEvento, ee.Motivo,
        ee.FechaEventoUtc
      FROM efectivo.entregas_eventos ee
      WHERE ee.EntregaId = e.EntregaId
      ORDER BY ee.FechaEventoUtc DESC, ee.EntregaEventoId DESC
    ) ev
    WHERE a.ResponsableUsuarioId = @userId
  `;
  const pendingFilter =
    "AND d.EntregaDetalleId IS NULL AND ev.EntregaEventoId IS NULL";

  return {
    async summary(userId) {
      const pool = await database.getPool();
      const { recordset } = await pool.request().input("userId", sql.Int, userId)
        .query(`
          WITH entregas_usuario AS (
            ${baseSelect}
          )
          SELECT
            COALESCE(SUM(ImporteProgramado), 0) AS TotalProgramado,
            COALESCE(SUM(COALESCE(ImporteEntregado, 0)), 0) AS TotalEntregado,
            COUNT(*) AS TotalEntregas,
            SUM(CASE WHEN Estado = 'PENDIENTE' THEN 1 ELSE 0 END) AS Pendientes,
            SUM(CASE WHEN Estado = 'ENTREGADA' THEN 1 ELSE 0 END) AS Entregadas,
            SUM(CASE WHEN Estado NOT IN ('PENDIENTE', 'ENTREGADA') THEN 1 ELSE 0 END) AS Incidencias
          FROM entregas_usuario;
        `);
      return mapSummary(recordset[0] ?? {});
    },
    async today(userId) {
      const pool = await database.getPool();
      const { recordset } = await pool.request().input("userId", sql.Int, userId)
        .query(`
          ${baseSelect}
          ${pendingFilter}
          ORDER BY e.FechaCreacionUtc ASC;
        `);
      return recordset.map(mapDelivery);
    },
    async history(userId, limit = 30) {
      const pool = await database.getPool();
      const { recordset } = await pool
        .request()
        .input("userId", sql.Int, userId)
        .input("limit", sql.Int, limit).query(`
          SELECT TOP (@limit) *
          FROM (${baseSelect}) entregas
          WHERE Estado = 'ENTREGADA'
          ORDER BY FechaConfirmacionUtc DESC, EntregaId DESC;
        `);
      return recordset.map(mapDelivery);
    },
    async detail(userId, deliveryId) {
      const pool = await database.getPool();
      const { recordset } = await pool
        .request()
        .input("userId", sql.Int, userId)
        .input("deliveryId", sql.BigInt, deliveryId).query(`
          SELECT TOP (1)
            e.EntregaId, e.AsignacionId, e.ClienteId, e.ClienteNombreSnapshot,
            e.ClienteRfcSnapshot, e.ImporteProgramado,
            COALESCE(d.Observaciones, ev.Observaciones, e.Observaciones) AS Observaciones,
            e.FechaCreacionUtc, d.ImporteEntregado, d.ReceptorNombre,
            d.FechaConfirmacionUtc, ev.Motivo, ev.FechaEventoUtc,
            d.FirmaMimeType, d.FirmaContenido, d.FirmaHashSha256,
            d.VideoId, d.VideoExtension, d.VideoMimeType, d.VideoTamanoBytes,
            d.VideoHashSha256,
            CASE
              WHEN d.EntregaDetalleId IS NOT NULL THEN 'ENTREGADA'
              WHEN ev.EntregaEventoId IS NOT NULL THEN ev.TipoEvento
              ELSE 'PENDIENTE'
            END AS Estado
          FROM efectivo.entregas e
          JOIN efectivo.asignaciones a ON a.AsignacionId = e.AsignacionId
          LEFT JOIN efectivo.entregas_detalle d ON d.EntregaId = e.EntregaId
          OUTER APPLY (
            SELECT TOP (1) ee.EntregaEventoId, ee.TipoEvento, ee.Motivo,
              ee.Observaciones, ee.FechaEventoUtc
            FROM efectivo.entregas_eventos ee
            WHERE ee.EntregaId = e.EntregaId
            ORDER BY ee.FechaEventoUtc DESC, ee.EntregaEventoId DESC
          ) ev
          WHERE e.EntregaId = @deliveryId
            AND a.ResponsableUsuarioId = @userId
            AND d.EntregaDetalleId IS NOT NULL;
        `);
      return recordset[0] ? mapDeliveryDetail(recordset[0]) : null;
    },
    async complete(userId, deliveryId, data) {
      const pool = await database.getPool();
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const delivery = await new sql.Request(tx)
          .input("userId", sql.Int, userId)
          .input("deliveryId", sql.BigInt, deliveryId).query(`
            SELECT e.EntregaId, e.ImporteProgramado
            FROM efectivo.entregas e
            JOIN efectivo.asignaciones a ON a.AsignacionId = e.AsignacionId
            WHERE e.EntregaId = @deliveryId
              AND a.ResponsableUsuarioId = @userId;
          `);
        if (delivery.recordset.length !== 1) {
          await tx.rollback();
          return { ok: false, status: 404 };
        }
        const existing = await new sql.Request(tx)
          .input("deliveryId", sql.BigInt, deliveryId).query(`
            SELECT TOP (1) EntregaDetalleId
            FROM efectivo.entregas_detalle
            WHERE EntregaId = @deliveryId;
          `);
        if (existing.recordset.length) {
          await tx.rollback();
          return { ok: false, status: 409 };
        }
        const signature = renderSignaturePng(data.signatureStrokes);
        const video = Buffer.from(data.videoBase64, "base64");
        const videoId = randomUUID();
        await new sql.Request(tx)
          .input("deliveryId", sql.BigInt, deliveryId)
          .input("amount", sql.Decimal(18, 2), data.amountDelivered)
          .input("receiver", sql.NVarChar(400), data.receiverName)
          .input("signatureMime", sql.NVarChar(200), "image/png")
          .input("signature", sql.VarBinary(sql.MAX), signature)
          .input("signatureHash", sql.Binary(32), binaryHash(signature))
          .input("videoId", sql.UniqueIdentifier, videoId)
          .input("videoExtension", sql.NVarChar(20), data.videoExtension)
          .input("videoMime", sql.NVarChar(200), data.videoMimeType)
          .input("videoSize", sql.BigInt, data.videoSizeBytes)
          .input("videoHash", sql.Binary(32), binaryHash(video))
          .input("key", sql.UniqueIdentifier, data.idempotencyKey)
          .input("notes", sql.NVarChar(2000), data.observations ?? null)
          .input("userId", sql.Int, userId).query(`
            INSERT INTO efectivo.entregas_detalle (
              EntregaId, ImporteEntregado, ReceptorNombre, FirmaMimeType,
              FirmaContenido, FirmaHashSha256, VideoId, VideoExtension,
              VideoMimeType, VideoTamanoBytes, VideoHashSha256,
              ClaveIdempotencia, Observaciones, ConfirmadoPorUsuarioId,
              FechaConfirmacionUtc
            )
            VALUES (
              @deliveryId, @amount, @receiver, @signatureMime, @signature,
              @signatureHash, @videoId, @videoExtension, @videoMime,
              @videoSize, @videoHash,
              @key, @notes, @userId, SYSUTCDATETIME()
            );
          `);
        await tx.commit();
        return { ok: true };
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        if (error.number === 2627 || error.number === 2601)
          return { ok: false, status: 409 };
        throw error;
      }
    },
    async reportIssue(userId, deliveryId, data) {
      const pool = await database.getPool();
      const { rowsAffected } = await pool
        .request()
        .input("userId", sql.Int, userId)
        .input("deliveryId", sql.BigInt, deliveryId)
        .input("reason", sql.NVarChar(500), data.reason)
        .input("released", sql.Decimal(18, 2), data.returnAmount)
        .input("notes", sql.NVarChar(2000), data.observations ?? null)
        .input("key", sql.UniqueIdentifier, data.idempotencyKey).query(`
          INSERT INTO efectivo.entregas_eventos (
            EntregaId, TipoEvento, Motivo, ImporteLiberado, Observaciones,
            ClaveIdempotencia, RegistradoPorUsuarioId, FechaEventoUtc
          )
          SELECT e.EntregaId, N'NO_ENTREGADO', @reason, @released, @notes,
            @key, @userId, SYSUTCDATETIME()
          FROM efectivo.entregas e
          JOIN efectivo.asignaciones a ON a.AsignacionId = e.AsignacionId
          LEFT JOIN efectivo.entregas_detalle d ON d.EntregaId = e.EntregaId
          WHERE e.EntregaId = @deliveryId
            AND a.ResponsableUsuarioId = @userId
            AND d.EntregaDetalleId IS NULL;
        `);
      return rowsAffected[0] === 1;
    },
  };
}
