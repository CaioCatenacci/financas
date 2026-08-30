import { test } from "node:test";
import assert from "node:assert/strict";

// Smoke: garante que o harness roda. Substituído pelos testes reais nas próximas tasks.
test("harness vivo", () => {
  assert.equal(1 + 1, 2);
});
