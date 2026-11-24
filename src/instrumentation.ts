export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnv, isProductionBuild } = await import("./env");
    validateEnv();
    if (!isProductionBuild()) {
      const { assertDatabaseRole } = await import("./server/db/assert-role");
      await assertDatabaseRole();
    }
  }
}
