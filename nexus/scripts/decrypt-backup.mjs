#!/usr/bin/env node
// Decrypt an off-server Nexus backup:  node scripts/decrypt-backup.mjs nexus-2026-11-18.db.enc nexus.db
// The passphrase is read from NEXUS_BACKUP_PASSPHRASE, or asked for interactively.
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { decrypt } from '../lib/offsite.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('Usage: node scripts/decrypt-backup.mjs <file.enc> <output>'); process.exit(1); }
let pass = process.env.NEXUS_BACKUP_PASSPHRASE;
if (!pass) { const rl = createInterface({ input: process.stdin, output: process.stderr }); pass = await rl.question('Backup passphrase: '); rl.close(); }
try { writeFileSync(output, decrypt(readFileSync(input), pass)); console.error(`Decrypted to ${output}`); }
catch (e) { console.error(`Could not decrypt: ${e.message.includes('auth') ? 'wrong passphrase or damaged file' : e.message}`); process.exit(1); }
