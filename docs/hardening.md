# Hardening the orchestrator on a shared computer

This app is often installed on a shared business computer that several
technicians log into. This guide explains what the built-in admin PIN protects,
what it does not, and the operating-system steps that actually protect the files
holding your PINs and secrets.

## What the admin PIN does

The admin PIN (Settings > Security, or the first-run wizard) gates the sensitive
keypad operations in the dashboard:

- Adding or changing a user's keypad PIN.
- Deleting a user manually.

A user can still change their own PIN by entering their current one, and a
removal that comes from the UniFi portal (synced over) is applied automatically
without the admin PIN. Every gated action is written to a tamper-evident,
hash-chained audit log (`audit-log.jsonl`).

This stops the common problem: a technician sitting at the machine changing PINs
through the dashboard without authorization.

## What the admin PIN does NOT do

The admin PIN is an application authorization control, not a filesystem control.
It cannot stop someone who opens the app's data folder. Specifically:

- All configuration lives in `config.json` in the app's data directory. Keypad
  PINs there are encrypted (see below), but the admin-PIN hash, the UniFi token,
  and other secrets are protected only by file permissions.
- Someone with access to that folder could blank the admin-PIN hash to disable
  the gate, edit stored codes directly, or restore an older backup.
- The file is written owner-only (`0600`), but **file permissions mean nothing
  when every technician logs into the same operating-system account**. They are
  all the same user and can read and write the file freely.

At-rest encryption of the PINs (AES-256-GCM, key in `secret.key`) raises the bar
against casual file browsing, but because the app must run unattended (it
reconciles locks and pushes PINs after an unprompted restart), the key has to
live on the same device. A determined local user on a shared account can
therefore still recover it. Treat at-rest encryption as obfuscation, not as
protection against someone who controls the machine.

## What actually protects the files

These are operating-system and deployment measures, outside the app:

1. **Give each technician their own OS login.** This is the single most
   important step. With separate accounts, the `0600` permission on `config.json`
   finally means something: only the account that runs the orchestrator can read
   it. A shared login defeats every file-level protection below.

2. **Run the orchestrator on a dedicated, locked-down device.** The cleanest
   option for a shared environment: run it headless on a Raspberry Pi or a small
   server that technicians never get a shell or file access to. They reach only
   the web dashboard (gated by the admin PIN and `admin_api_key`); tampering with
   the files then requires physically compromising that device.

3. **Enable full-disk encryption** (BitLocker on Windows, FileVault on macOS,
   LUKS on Linux). This protects the config if the drive is removed or the
   machine is booted from other media. It does not protect against a user who is
   already logged in.

4. **Lock down the data folder's permissions/ACLs** so only the service account
   can read it:
   - Windows: `%APPDATA%\UniFi Access Orchestrator\`
   - macOS: `~/Library/Application Support/UniFi Access Orchestrator/`
   - Linux (desktop): `~/.config/UniFi Access Orchestrator/`
   - Headless: the config directory you configured (e.g. alongside the repo or a
     path set via `MIDDLEWARE_CONFIG_PATH` / `CONFIG_PATH`).

5. **Set `server.admin_api_key`** so remote browsers must present it, and keep
   the dashboard port off untrusted networks (a reverse proxy with TLS, or a
   VPN/allowlist). This is separate from the admin PIN.

## Files to protect and never commit

All of these live in the config directory and are owner-only (`0600`):

- `config.json` - all settings and secrets (keypad PINs encrypted).
- `secret.key` - the at-rest PIN encryption key. If you lose it, encrypted PINs
  cannot be recovered; if it leaks, at-rest encryption is void. Back it up
  together with `config.json`, and store the backup somewhere at least as
  protected as the originals.
- `audit-log.jsonl` - the tamper-evident audit trail.
- `backups/` - configuration snapshots (also contain encrypted PINs).

They are already excluded from version control in `.gitignore`. Never commit
them or paste their contents anywhere.

## A note on the audit log

The app has one shared admin credential and no per-technician identity, so audit
entries record *what* happened (and prove the record has not been altered), but
attribute actions to a role (`admin`, `user`, `system`), not to a specific
person. Per-person accountability requires separate OS logins (step 1) plus your
own access controls in front of the dashboard.
