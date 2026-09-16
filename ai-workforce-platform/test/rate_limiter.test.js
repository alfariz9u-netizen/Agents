"use strict";

const assert = require("node:assert");
const RateLimiter = require("../src/core/rateLimiter");

async function main() {
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 10 });

  assert.strictEqual(limiter.tryConsume("connX"), true);
  assert.strictEqual(limiter.tryConsume("connX"), true);
  assert.strictEqual(limiter.tryConsume("connX"), true);
  console.log("PASS: bucket allows up to its capacity");

  assert.strictEqual(limiter.tryConsume("connX"), false, "4th immediate call should be blocked");
  console.log("PASS: exceeding capacity is blocked");

  assert.throws(() => limiter.assertConsume("connX"), /Rate limit exceeded/);
  console.log("PASS: assertConsume throws a clear error when exhausted");

  // A different key has its own independent bucket.
  assert.strictEqual(limiter.tryConsume("connY"), true);
  console.log("PASS: buckets are isolated per key — one connector's abuse doesn't block another");

  await new Promise((r) => setTimeout(r, 150)); // 150ms * 10/sec refill ~= 1.5 tokens
  assert.strictEqual(limiter.tryConsume("connX"), true, "bucket should have refilled at least one token");
  console.log("PASS: bucket refills over time");
}

main()
  .then(() => {
    console.log("\nRate limiter tests passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("TEST FAILURE:", err);
    process.exit(1);
  });
