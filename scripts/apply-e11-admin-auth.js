// scripts/apply-e11-admin-auth.js
// E11 (FB) · port requireAdminToken middleware from LINE bot
//
// Why: /admin/refresh-testmode-cache is currently PUBLIC · anyone can hit it
//      LINE bot has requireAdminToken on all /admin/* /stats /bot-stats /recent etc.
//      FB violates NEVER-rule in CLAUDE.md: "ห้ามเปิด ops endpoints แบบ public"
//
// Fix: add requireAdminToken middleware · gate /admin/refresh-testmode-cache
//      use Bearer ADMIN_API_TOKEN (same env var as LINE bot)
//
// IDEMPOTENT: marker E11_FB_ADMIN_AUTH
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const BAK = FILE + '.bak-e11-' + new Date().toISOString().replace(/[:.]/g, '-');
const DRY_RUN = process.argv.includes('--dry-run');
const MARKER = 'E11_FB_ADMIN_AUTH';

const OLD = `app.post("/admin/refresh-testmode-cache", (_req, res) => {
  invalidateCache();
  res.json({ ok: true, message: "TestMode cache invalidated" });
});`;

const NEW = `// ${MARKER}: gate admin endpoints with Bearer ADMIN_API_TOKEN (parity w/ LINE bot E11)
// Pattern: \`Authorization: Bearer $ADMIN_API_TOKEN\` · 401 if mismatch · 503 if env unset
function requireAdminToken(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    console.warn("[E11] ADMIN_API_TOKEN not set · /admin/* will 503");
    return res.status(503).json({ error: "ADMIN_API_TOKEN not configured" });
  }
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (provided !== token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/admin/refresh-testmode-cache", requireAdminToken, (_req, res) => {
  invalidateCache();
  res.json({ ok: true, message: "TestMode cache invalidated" });
});`;

function main() {
  const original = fs.readFileSync(FILE, 'utf8');
  console.log(`📖 Read ${FILE} (${original.length} bytes)`);

  if (original.includes(MARKER)) {
    console.log(`⏭️  ${MARKER} already present · NO-OP`);
    process.exit(0);
  }

  if (!original.includes(OLD)) {
    console.error(`❌ Anchor not found · cannot patch safely`);
    process.exit(1);
  }

  const patched = original.replace(OLD, NEW);
  console.log(`\n📐 Patch ready · adds ${patched.length - original.length} bytes`);

  if (DRY_RUN) { console.log(`\n💡 Dry run · no changes written.`); process.exit(0); }

  fs.writeFileSync(BAK, original);
  console.log(`💾 Backup: ${BAK}`);
  fs.writeFileSync(FILE, patched);
  console.log(`✍️  Wrote ${FILE}`);

  const verify = fs.readFileSync(FILE, 'utf8');
  const checks = [
    [verify.includes(MARKER), 'marker'],
    [verify.includes('function requireAdminToken'), 'middleware function'],
    [verify.includes('Bearer '), 'Bearer scheme'],
    [verify.includes('ADMIN_API_TOKEN'), 'env var ref'],
    [verify.includes('"/admin/refresh-testmode-cache", requireAdminToken'), 'route wired'],
    [verify.includes('401'), '401 unauthorized'],
    [verify.includes('503'), '503 not configured'],
  ];
  let pass = true;
  console.log(`\n🔍 Verifying:`);
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) pass = false;
  }

  if (pass) {
    console.log(`\n🎉 E11 applied. Next:`);
    console.log(`   1) Add ADMIN_API_TOKEN env var to Railway fb-chat-service`);
    console.log(`      (use SAME value as LINE bot · Phao knows the token)`);
    console.log(``);
    console.log(`   2) git add server.js scripts/apply-e11-admin-auth.js`);
    console.log(`   3) git commit -m "fix(e11-fb): gate /admin/refresh-testmode-cache with requireAdminToken"`);
    console.log(`   4) git push`);
    console.log(``);
    console.log(`   Smoke after Railway redeploy:`);
    console.log(`     curl -X POST https://<fb-url>/admin/refresh-testmode-cache`);
    console.log(`     → expect 401 (no auth)`);
    console.log(``);
    console.log(`     curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \\`);
    console.log(`          https://<fb-url>/admin/refresh-testmode-cache`);
    console.log(`     → expect 200 {"ok":true}`);
  } else {
    console.error(`\n❌ Verification failed · restoring backup`);
    fs.copyFileSync(BAK, FILE);
    process.exit(1);
  }
}

main();
