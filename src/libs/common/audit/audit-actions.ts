/**
 * Canonical taxonomy of audited actions. Centralised so the set is
 * discoverable and call sites are typo-checked (the per-service audit helpers
 * type their `action` against {@link AuditAction}). Values are the strings
 * persisted to `audit_logs.action`.
 */
export const AuditAction = {
  // ── Login / session ───────────────────────────────────────────────────────
  LOGIN: 'auth.login',
  GOOGLE_LOGIN: 'auth.google_login',
  TWO_FACTOR_LOGIN: 'auth.2fa_login',
  PASSKEY_LOGIN: 'auth.passkey_login',
  NEW_DEVICE_LOGIN: 'auth.new_device_login',
  LOGIN_FAILED: 'auth.login_failed',
  ACCOUNT_LOCKED: 'auth.account_locked',

  // ── Registration / verification ───────────────────────────────────────────
  REGISTER: 'auth.register',
  GOOGLE_REGISTER: 'auth.google_register',
  REGISTER_DUPLICATE: 'auth.register_duplicate',
  VERIFICATION_RESENT: 'auth.verification_resent',

  // ── Account / credentials ─────────────────────────────────────────────────
  ACCOUNT_LINKED: 'auth.account_linked',
  PROVIDER_DISCONNECTED: 'auth.provider_disconnected',
  PASSWORD_SET: 'auth.password_set',
  EMAIL_CHANGE_REQUESTED: 'auth.email_change_requested',
  EMAIL_CHANGED: 'auth.email_changed',

  // ── 2FA / passkeys ────────────────────────────────────────────────────────
  BACKUP_CODES_REGENERATED: 'auth.backup_codes_regenerated',
  BACKUP_CODE_USED: 'auth.backup_code_used',
  PASSKEY_REGISTERED: 'auth.passkey_registered',
  PASSKEY_REMOVED: 'auth.passkey_removed',

  // ── Lifecycle / privacy ───────────────────────────────────────────────────
  ACCOUNT_DELETED: 'auth.account_deleted',
  DATA_EXPORTED: 'auth.data_exported',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

// Actions that represent a completed login — the device history that the
// new-device alert fingerprints against.
export const LOGIN_ACTIONS: AuditAction[] = [
  AuditAction.LOGIN,
  AuditAction.GOOGLE_LOGIN,
  AuditAction.TWO_FACTOR_LOGIN,
  AuditAction.PASSKEY_LOGIN,
];
