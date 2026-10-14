import sql from "mssql";

export function createUserRepository(database) {
  return {
    async findByUsername(username) {
      const pool = await database.getPool();
      const { recordset } = await pool
        .request()
        .input("username", sql.NVarChar(100), username)
        .query(`SELECT TOP (2) UsuarioId, Usuario, NombreCompleto, Email,
          PasswordHash, PasswordSalt, PasswordIterations, PasswordAlgorithm,
          Activo, Bloqueado, RequiereCambioPassword
          FROM dbo.seg_usuarios WHERE Usuario = @username`);
      // Ambiguous names must not authenticate an arbitrary account.
      return recordset.length === 1 ? recordset[0] : null;
    },
    async updatePassword(userId, passwordRecord) {
      const pool = await database.getPool();
      const { rowsAffected } = await pool
        .request()
        .input("userId", sql.Int, userId)
        .input("hash", sql.VarBinary(64), passwordRecord.PasswordHash)
        .input("salt", sql.VarBinary(32), passwordRecord.PasswordSalt)
        .input("iterations", sql.Int, passwordRecord.PasswordIterations)
        .input(
          "algorithm",
          sql.NVarChar(50),
          passwordRecord.PasswordAlgorithm,
        ).query(`UPDATE dbo.seg_usuarios
          SET PasswordHash = @hash,
            PasswordSalt = @salt,
            PasswordIterations = @iterations,
            PasswordAlgorithm = @algorithm,
            RequiereCambioPassword = 0,
            UltimoCambioPasswordUtc = SYSUTCDATETIME(),
            FechaActualizacion = SYSUTCDATETIME()
          WHERE UsuarioId = @userId
            AND Activo = 1
            AND Bloqueado = 0
            AND RequiereCambioPassword = 1`);
      return rowsAffected[0] === 1;
    },
    async findById(id) {
      const pool = await database.getPool();
      const { recordset } = await pool.request().input("id", sql.Int, id)
        .query(`SELECT UsuarioId, Usuario, NombreCompleto, Email,
          Activo, Bloqueado, RequiereCambioPassword
          FROM dbo.seg_usuarios WHERE UsuarioId = @id`);
      return recordset[0] ?? null;
    },
  };
}
