const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore } = require("../electron/state.cjs");
const { trustedHomesEnvironment, usableTrustedHomes, validateTrustedHomes, discoverOrcaTrustedHomes } = require("../electron/trusted-homes.cjs");

test("Orca account homes are discovered without duplicates or incomplete accounts", () => withHomes(1, (root, [manual]) => {
  const accounts = path.join(root, "orca", "codex-accounts");
  const home = path.join(accounts, "account", "home");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(accounts, "incomplete", "home"), { recursive: true });
  const discovered = discoverOrcaTrustedHomes([manual], root);
  assert.deepEqual(discovered, [manual, fs.realpathSync(home)]);
  assert.deepEqual(discoverOrcaTrustedHomes(discovered, root), discovered);
}));

test("missing Orca installation preserves saved homes", () => withHomes(1, (root, homes) => {
  assert.deepEqual(discoverOrcaTrustedHomes(homes, root), homes);
}));

test("Orca discovery respects the seven-home runtime limit", () => withHomes(6, (root, homes) => {
  for (const account of ["a", "b"]) {
    fs.mkdirSync(path.join(root, "orca", "codex-accounts", account, "home", "sessions"), { recursive: true });
  }
  const discovered = discoverOrcaTrustedHomes(homes, root);
  assert.equal(discovered.length, 7);
  assert.deepEqual(discovered.slice(0, 6), homes);
  assert.doesNotThrow(() => trustedHomesEnvironment(discovered));
}));

function withHomes(count, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fame-trusted-homes-"));
  try {
    const homes = Array.from({ length: count }, (_, index) => {
      const home = path.join(root, `home-${index}`);
      fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
      return home;
    });
    return run(root, homes.map(home => fs.realpathSync(home)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("a trusted home must be an existing absolute directory with sessions, without duplicates", () => withHomes(1, (root, [home]) => {
  assert.deepEqual(validateTrustedHomes([home]), [home]);
  assert.throws(() => validateTrustedHomes([home, home]), /already selected/);
  assert.throws(() => validateTrustedHomes(["relative"]), /absolute/);
  const bare = path.join(root, "bare");
  fs.mkdirSync(bare);
  assert.throws(() => validateTrustedHomes([bare]), /sessions/);
  assert.throws(() => validateTrustedHomes(Array.from({ length: 8 }, () => home)), /at most seven/);
}));

test("startup registration drops homes that vanished instead of failing the runtime", () => withHomes(2, (root, [kept, removed]) => {
  fs.rmSync(removed, { recursive: true });
  assert.deepEqual(usableTrustedHomes([kept, removed]), [kept]);
  assert.equal(trustedHomesEnvironment([removed]), null);
  assert.deepEqual(JSON.parse(trustedHomesEnvironment([kept, removed])), [kept]);
}));

test("trusted homes persist and corrupt saved lists reset", () => withHomes(1, (root, [home]) => {
  const file = path.join(root, "state.json");
  assert.deepEqual(createStateStore(file).read().trustedCodexHomes, []);
  createStateStore(file).update({ trustedCodexHomes: [home] });
  assert.deepEqual(createStateStore(file).read().trustedCodexHomes, [home]);
  fs.writeFileSync(file, JSON.stringify({ version: 1, trustedCodexHomes: "x" }));
  assert.deepEqual(createStateStore(file).read().trustedCodexHomes, []);
}));
