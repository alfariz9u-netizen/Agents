"use strict";

const assert = require("node:assert");
const { assertSafeUrl, isBlockedHostnameLiteral, decodeObfuscatedIPv4 } = require("../src/core/ssrfGuard");

async function main() {
  // --- Literal IP blocking ---
  const blockedLiterals = ["127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "0.0.0.0"];
  for (const ip of blockedLiterals) {
    assert.strictEqual(isBlockedHostnameLiteral(ip), true, `${ip} should be blocked`);
  }
  console.log("PASS: private/loopback/link-local/metadata literal IPs are blocked");

  assert.strictEqual(isBlockedHostnameLiteral("8.8.8.8"), false);
  assert.strictEqual(isBlockedHostnameLiteral("93.184.216.34"), false);
  console.log("PASS: ordinary public IPs are not blocked");

  // --- Obfuscation bypass attempts ---
  assert.strictEqual(decodeObfuscatedIPv4("2130706433"), "127.0.0.1", "decimal-encoded 127.0.0.1");
  assert.strictEqual(decodeObfuscatedIPv4("0x7f000001"), "127.0.0.1", "hex-encoded 127.0.0.1");
  assert.strictEqual(isBlockedHostnameLiteral("2130706433"), true, "decimal IP obfuscation must still be blocked");
  assert.strictEqual(isBlockedHostnameLiteral("0x7f000001"), true, "hex IP obfuscation must still be blocked");
  console.log("PASS: decimal/hex IP-literal obfuscation bypasses are caught");

  assert.strictEqual(isBlockedHostnameLiteral("localhost"), true);
  assert.strictEqual(isBlockedHostnameLiteral("metadata.google.internal"), true);
  console.log("PASS: known dangerous hostnames are blocked");

  // --- Protocol rejection ---
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), /unsupported protocol/);
  await assert.rejects(() => assertSafeUrl("ftp://example.com/x"), /unsupported protocol/);
  console.log("PASS: non-http(s) protocols are rejected");

  // --- Direct private-IP URL rejection (no DNS needed) ---
  await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"), /private\/internal/);
  console.log("PASS: cloud metadata endpoint URL is rejected outright");

  // --- DNS-rebinding style attack: hostname LOOKS public but resolves to a private IP ---
  const maliciousResolver = async () => ["10.0.0.55"]; // simulates a hostname resolving to an internal IP
  await assert.rejects(
    () => assertSafeUrl("http://looks-public-but-isnt.example.com/", { resolver: maliciousResolver }),
    /resolves to private\/internal address/
  );
  console.log("PASS: a hostname that resolves to a private IP via DNS is rejected (DNS-rebinding defense)");

  // --- Legitimate public resolution passes ---
  const benignResolver = async () => ["93.184.216.34"];
  const result = await assertSafeUrl("https://example.com/agent-card.json", { resolver: benignResolver });
  assert.strictEqual(result.hostname, "example.com");
  console.log("PASS: a genuinely public hostname passes validation");

  // --- allowPrivate escape hatch works for legitimate local testing only when explicitly requested ---
  const allowed = await assertSafeUrl("http://127.0.0.1:8080/test", { allowPrivate: true });
  assert.strictEqual(allowed.hostname, "127.0.0.1");
  console.log("PASS: allowPrivate explicit override works for legitimate local testing");
}

main()
  .then(() => {
    console.log("\nSSRF guard tests passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("TEST FAILURE:", err);
    process.exit(1);
  });
