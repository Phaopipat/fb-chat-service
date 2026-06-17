// Fix multi-line JSON value in .env (Railway paste pastes pretty-printed JSON)
// Joins GOOGLE_SERVICE_ACCOUNT_JSON value into 1 line · preserves \n in private_key
// Usage: node scripts/fix-env-multiline.js
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const raw = fs.readFileSync(ENV_PATH, 'utf8');
const lines = raw.split('\n');

const output = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  // Detect multi-line JSON value
  if (line.startsWith('GOOGLE_SERVICE_ACCOUNT_JSON=') && line.endsWith('={')) {
    // Collect lines until closing brace
    const collected = ['{'];
    i++;
    let braceDepth = 1;
    while (i < lines.length && braceDepth > 0) {
      const part = lines[i];
      // Count braces (handle escaped)
      for (const ch of part) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      collected.push(part);
      i++;
    }
    // Join · convert real newlines in private_key to escaped \n
    let json = collected.join('\n');
    // Try to parse · if valid, stringify in 1 line
    try {
      const obj = JSON.parse(json);
      const oneLine = JSON.stringify(obj);
      output.push('GOOGLE_SERVICE_ACCOUNT_JSON=' + oneLine);
      console.log('OK · JSON joined to 1 line (' + oneLine.length + ' chars)');
    } catch (e) {
      console.error('ERR · could not parse JSON:', e.message);
      console.error('Manual fix needed');
      process.exit(1);
    }
  } else {
    output.push(line);
    i++;
  }
}

// Backup before write
fs.writeFileSync(ENV_PATH + '.backup', raw);
fs.writeFileSync(ENV_PATH, output.join('\n'));
console.log('Backup saved to .env.backup');
console.log('Fixed .env written · new line count:', output.length);
