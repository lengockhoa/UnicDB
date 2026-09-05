import { it, expect } from "vitest";
import { extractIdentifierReferences } from "/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/src/core/statementParser";
it("dbg", () => {
  const sql = "SELECT orders.user_id FROM orders JOIN users ON orders.user_id = users.id;";
  console.log(JSON.stringify(extractIdentifierReferences(sql), null, 1));
  expect(true).toBe(true);
});
