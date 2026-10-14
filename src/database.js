import sql from "mssql";

export function createDatabase(config) {
  const pool = new sql.ConnectionPool(config);
  pool.on("error", (error) =>
    console.error("SQL pool:", error.code || "ERROR"),
  );
  let connecting;
  return {
    async getPool() {
      if (!connecting)
        connecting = pool.connect().catch((error) => {
          connecting = undefined;
          throw error;
        });
      return connecting;
    },
    async close() {
      await pool.close();
    },
  };
}
