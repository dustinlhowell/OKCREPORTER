#!/bin/sh
# Adds settings fields introduced in newer Nexus versions to your installed Unraid template,
# keeping all your existing values. Safe to run more than once.
F=/boot/config/plugins/dockerMan/templates-user/my-Nexus.xml
[ -f "$F" ] || { echo "Template not found at $F"; exit 1; }
cp "$F" "$F.bak"
added=0
add() { if ! grep -q "Target=\"$1\"" "$F"; then sed -i "s#</Container>#$2\n</Container>#" "$F"; added=$((added+1)); fi; }
add "SMTP_HOST" "  <Config Name=\"Notify: SMTP host\" Target=\"SMTP_HOST\" Default=\"\" Mode=\"\" Description=\"Email notifications: your mail provider's SMTP server, e.g. smtp.gmail.com\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "SMTP_PORT" "  <Config Name=\"Notify: SMTP port\" Target=\"SMTP_PORT\" Default=\"587\" Mode=\"\" Description=\"587 (STARTTLS) or 465 (TLS)\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\">587</Config>"
add "SMTP_USER" "  <Config Name=\"Notify: SMTP user\" Target=\"SMTP_USER\" Default=\"\" Mode=\"\" Description=\"Usually your email address\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "SMTP_PASS" "  <Config Name=\"Notify: SMTP password\" Target=\"SMTP_PASS\" Default=\"\" Mode=\"\" Description=\"For Gmail/iCloud use an app password\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"true\"></Config>"
add "SMTP_FROM" "  <Config Name=\"Notify: SMTP from\" Target=\"SMTP_FROM\" Default=\"\" Mode=\"\" Description=\"e.g. Nexus \&lt;you@gmail.com\&gt;\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "PUSHOVER_TOKEN" "  <Config Name=\"Notify: Pushover app token\" Target=\"PUSHOVER_TOKEN\" Default=\"\" Mode=\"\" Description=\"Optional: Pushover application token\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"true\"></Config>"
add "UNRAID_URL" "  <Config Name=\"Unraid API URL\" Target=\"UNRAID_URL\" Default=\"\" Mode=\"\" Description=\"Your Unraid web UI address, e.g. http://192.168.1.10 – shows array/disks/containers on Home\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "UNRAID_API_KEY" "  <Config Name=\"Unraid API key\" Target=\"UNRAID_API_KEY\" Default=\"\" Mode=\"\" Description=\"Settings → Management Access → API Keys (read access)\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"true\"></Config>"
add "BACKUP_S3_ENDPOINT" "  <Config Name=\"Backup: S3 endpoint\" Target=\"BACKUP_S3_ENDPOINT\" Default=\"\" Mode=\"\" Description=\"Off-server backups, e.g. https://s3.us-west-004.backblazeb2.com\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "BACKUP_S3_BUCKET" "  <Config Name=\"Backup: S3 bucket\" Target=\"BACKUP_S3_BUCKET\" Default=\"\" Mode=\"\" Description=\"Bucket name\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "BACKUP_S3_REGION" "  <Config Name=\"Backup: S3 region\" Target=\"BACKUP_S3_REGION\" Default=\"us-east-1\" Mode=\"\" Description=\"e.g. us-west-004 for Backblaze B2\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\">us-east-1</Config>"
add "BACKUP_S3_KEY_ID" "  <Config Name=\"Backup: S3 key ID\" Target=\"BACKUP_S3_KEY_ID\" Default=\"\" Mode=\"\" Description=\"Access key / application key ID\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"></Config>"
add "BACKUP_S3_SECRET" "  <Config Name=\"Backup: S3 secret\" Target=\"BACKUP_S3_SECRET\" Default=\"\" Mode=\"\" Description=\"Secret / application key\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"true\"></Config>"
add "BACKUP_PASSPHRASE" "  <Config Name=\"Backup: passphrase\" Target=\"BACKUP_PASSPHRASE\" Default=\"\" Mode=\"\" Description=\"Encrypts off-server backups (required for cloud). Store it safely – backups can't be restored without it.\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"true\"></Config>"
add "WEEKLY_REVIEW" "  <Config Name=\"Weekly review\" Target=\"WEEKLY_REVIEW\" Default=\"on\" Mode=\"\" Description=\"on/off – Sunday 18:00 weekly review note\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\">on</Config>"
add "/backup-copy" "  <Config Name=\"Backup: copy to folder\" Target=\"/backup-copy\" Default=\"\" Mode=\"rw\" Description=\"Optional: a folder on another disk/share for encrypted backup copies. Also set BACKUP_COPY_DIR=/backup-copy below.\" Type=\"Path\" Display=\"advanced\" Required=\"false\" Mask=\"false\"/>"
add "BACKUP_COPY_DIR" "  <Config Name=\"Backup: copy dir (inside container)\" Target=\"BACKUP_COPY_DIR\" Default=\"\" Mode=\"\" Description=\"Set to /backup-copy if you mapped the folder above\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\"/>"
add "ANTHROPIC_API_KEY" "  <Config Name=\"Anthropic API key\" Target=\"ANTHROPIC_API_KEY\" Default=\"\" Mode=\"\" Description=\"Enables Ask Claude\" Type=\"Variable\" Display=\"always\" Required=\"false\" Mask=\"true\"></Config>"
add "CLAUDE_WEB" "  <Config Name=\"Claude web access\" Target=\"CLAUDE_WEB\" Default=\"on\" Mode=\"\" Description=\"on/off\" Type=\"Variable\" Display=\"advanced\" Required=\"false\" Mask=\"false\">on</Config>"
echo "Added $added new field(s). Refresh the Unraid page, then Docker → Nexus → Edit → Show more settings. (Backup of the old template: $F.bak)"
