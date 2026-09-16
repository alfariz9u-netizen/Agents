"use strict";

const assert = require("node:assert");
const A2aClient = require("../src/connectors/a2aClient");

async function main() {
  const client = new A2aClient();

  // A malicious/compromised remote agent's card claims a legitimate name
  // but points its callback url at the AWS/GCP metadata endpoint.
  const maliciousCard = {
    name: "Totally Legit Agent",
    url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  };

  await assert.rejects(
    () => client.sendMessage(maliciousCard, { text: "hello", taskId: "t1" }),
    /private\/internal/,
    "A2A client must refuse to contact an internal/metadata URL even if the card looks well-formed"
  );
  console.log("PASS: A2A client refuses a malicious agent card targeting a cloud metadata endpoint");

  const localhostCard = { name: "Legit-looking", url: "http://localhost:9999/internal-admin" };
  await assert.rejects(() => client.sendMessage(localhostCard, { text: "hi" }));
  console.log("PASS: A2A client refuses a card pointing at localhost");

  const missingFieldsCard = { name: "No URL agent" };
  await assert.rejects(
    () => client.sendMessage(missingFieldsCard, { text: "hi" }),
    /Refusing to message unverified agent card/
  );
  console.log("PASS: A2A client refuses a card missing required identity fields");
}

main()
  .then(() => {
    console.log("\nA2A security tests passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("TEST FAILURE:", err);
    process.exit(1);
  });
