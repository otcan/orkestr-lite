import assert from "node:assert/strict";
import { test } from "node:test";
import { whatsAppDocumentMime } from "./whatsapp-client.factory.js";

test("normalizes Markdown documents for WhatsApp's binary uploader", () => {
  assert.equal(
    whatsAppDocumentMime("text/markdown"),
    "application/octet-stream",
  );
  assert.equal(whatsAppDocumentMime(null), "application/octet-stream");
  assert.equal(whatsAppDocumentMime("application/pdf"), "application/pdf");
});
