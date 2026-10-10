// Which API keys a session uses. Local mode: the server's .env keys, then keys
// stored in orgs.yaml (.env wins). Hosted mode: only the organisation's own stored keys, never the
// server's, and none for a disabled organisation. Decrypted keys are cached per organisation and
// provider (a new stored value is a cache miss) and registered with the log scrubber.
import { type Logger, pino } from "pino";
import type { LoadedConfig, Secrets } from "../config.js";
import { addSecret, removeSecret } from "../log.js";
import type { AppMode, KeyProvider, KeyStatus } from "../shared/protocol.js";
import { KeyStoreError, MasterKey } from "./keystore.js";
import { LOCAL_ORG_ID, type OrgRecord, OrgStore } from "./orgs.js";

export const KEY_PROVIDERS: readonly KeyProvider[] = ["soniox"];

const SECRET_FIELD: Record<KeyProvider, keyof Secrets> = {
  soniox: "sonioxApiKey",
};

export interface KeyResolverOptions {
  mode: AppMode;
  /** The server's .env keys (local mode only). */
  env: Secrets;
  orgs: OrgStore;
  master: MasterKey;
  log: Logger;
  now?: () => number;
}

export class KeyResolver {
  private readonly cache = new Map<string, { sealed: string; plain: string | null }>();

  constructor(private readonly opts: KeyResolverOptions) {
    addSecret(opts.env.sonioxApiKey);
  }

  /** The keys sessions of `orgId` run with (null = missing). Never throws. */
  resolve(orgId: string): Secrets {
    const out: Secrets = { sonioxApiKey: null };
    let org: OrgRecord | undefined;
    try {
      org = this.opts.orgs.get(orgId);
    } catch (err) {
      this.opts.log.error({ err, org: orgId }, "keys: orgs.yaml could not be read");
    }
    if (this.opts.mode === "hosted" && (org === undefined || org.disabled)) return out;
    for (const provider of KEY_PROVIDERS) {
      out[SECRET_FIELD[provider]] = this.envKey(orgId, provider) ?? this.stored(org, provider);
    }
    return out;
  }

  /** What the app may show about each key (never the key). */
  status(orgId: string): Record<KeyProvider, KeyStatus> {
    const org = this.opts.orgs.get(orgId);
    const one = (provider: KeyProvider): KeyStatus => {
      const env = this.envKey(orgId, provider);
      if (env !== null) {
        return { provider, set: true, last4: env.slice(-4), validatedAt: null, source: "env" };
      }
      const meta = org?.keyMeta[provider];
      if (this.stored(org, provider) === null || meta === undefined) {
        return { provider, set: false, last4: null, validatedAt: null, source: null };
      }
      return {
        provider,
        set: true,
        last4: meta.last4,
        validatedAt: meta.validatedAt,
        source: "stored",
      };
    };
    return { soniox: one("soniox") };
  }

  /** Encrypt and store a key for an organisation (replacing the previous one). */
  store(
    orgId: string,
    provider: KeyProvider,
    key: string,
    meta: { validated: boolean; by: string | null },
  ): KeyStatus {
    // A lost master.key must not be silently replaced while other keys are still sealed with it:
    // a new one would make every stored key unreadable.
    if (
      !this.opts.master.exists() &&
      this.opts.orgs.list().some((o) => Object.keys(o.keys).length > 0)
    ) {
      throw new KeyStoreError(
        "master.key is missing while orgs.yaml holds encrypted keys: restore master.key (or TURJUMAN_MASTER_KEY) first",
      );
    }
    addSecret(key, `${orgId}:${provider}`);
    const sealed = this.opts.master.encrypt(orgId, provider, key);
    const at = new Date((this.opts.now ?? Date.now)()).toISOString();
    this.opts.orgs.setKey(orgId, provider, sealed, {
      last4: key.slice(-4),
      validatedAt: meta.validated ? at : null,
      addedAt: at,
      addedBy: meta.by,
    });
    this.cache.set(`${orgId}:${provider}`, { sealed, plain: key });
    return this.status(orgId)[provider];
  }

  remove(orgId: string, provider: KeyProvider): KeyStatus {
    this.opts.orgs.removeKey(orgId, provider);
    this.cache.delete(`${orgId}:${provider}`);
    removeSecret(`${orgId}:${provider}`);
    return this.status(orgId)[provider];
  }

  /** Local mode, the local organisation: the .env key. */
  private envKey(orgId: string, provider: KeyProvider): string | null {
    if (this.opts.mode !== "local" || orgId !== LOCAL_ORG_ID) return null;
    return this.opts.env[SECRET_FIELD[provider]];
  }

  private stored(org: OrgRecord | undefined, provider: KeyProvider): string | null {
    const sealed = org?.keys[provider];
    if (org === undefined || sealed === undefined) return null;
    const id = `${org.id}:${provider}`;
    const hit = this.cache.get(id);
    if (hit !== undefined && hit.sealed === sealed) return hit.plain;
    let plain: string | null = null;
    try {
      plain = this.opts.master.decrypt(org.id, provider, sealed);
      addSecret(plain, id);
    } catch (err) {
      const reason = err instanceof KeyStoreError ? err.message : "unexpected error";
      this.opts.log.error({ org: org.id, provider, reason }, "keys: a stored key cannot be used");
    }
    this.cache.set(id, { sealed, plain });
    return plain;
  }
}

/** A resolver for the local organisation's stored keys only (no .env keys), logging nothing. */
function localStoredResolver(loaded: LoadedConfig, master: MasterKey): KeyResolver {
  return new KeyResolver({
    mode: "local",
    env: { sonioxApiKey: null },
    orgs: new OrgStore(loaded.paths.orgsFile),
    master,
    log: pino({ level: "silent" }),
  });
}

/**
 * Local mode: the API keys added in the app (stored encrypted in orgs.yaml), decrypted, for the
 * checks of `setup --check` and `doctor --online`. A key that cannot be read counts as missing
 * (neither this nor storedLocalKeys throws: OrgStore keeps a broken orgs.yaml as an error and the
 * resolver turns an unreadable key into a missing one).
 */
export function storedLocalKeyValues(
  loaded: LoadedConfig,
  master: MasterKey = new MasterKey(loaded.paths.masterKeyFile),
): Record<KeyProvider, string | null> {
  return { soniox: localStoredResolver(loaded, master).resolve(LOCAL_ORG_ID).sonioxApiKey };
}

/**
 * Local mode: which API keys were added in the app (stored encrypted in orgs.yaml) rather than in
 * .env, for `doctor` and `start`. A key that cannot be read counts as missing.
 */
export function storedLocalKeys(
  loaded: LoadedConfig,
  master: MasterKey = new MasterKey(loaded.paths.masterKeyFile),
): Record<KeyProvider, boolean> {
  return { soniox: localStoredResolver(loaded, master).status(LOCAL_ORG_ID).soniox.set };
}
