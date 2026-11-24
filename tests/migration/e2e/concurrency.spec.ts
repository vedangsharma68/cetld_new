import { test, expect } from "@playwright/test";
test("concurrent unconfigured email requests never create usable accounts", async ({
  request,
}) => {
  const responses = await Promise.all(
    [1, 2].map(() =>
      request.post("/api/v1/auth/signup", {
        headers: { origin: "http://127.0.0.1:3107" },
        data: {
          email: "concurrent@example.test",
          password: "synthetic-local-password-only",
          name: "Name",
          businessName: "Business",
        },
      }),
    ),
  );
  expect(responses.map((r) => r.status())).toEqual([503, 503]);
});
