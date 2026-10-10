// Organisation API: sign-up (hosted), the caller's organisation, its usage and
// its API keys. Keys go in and never come out: the browser only ever sees a KeyStatus (set, last
// four characters, when it was checked). A key is checked with its provider before it is stored;
// a rejected key is not stored and counts as a failed attempt for the address.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KeyStoreError } from "../accounts/keystore.js";
import { cleanOrgName } from "../accounts/orgs.js";
import { hashPassword, verifyPassword } from "../accounts/passwords.js";
import { PROVIDER_NAMES } from "../accounts/provider-check.js";
import { normalizeEmail, toMe, type UserRecord } from "../accounts/users.js";
import { FailureRateLimiter } from "../auth/rate-limit.js";
import { orgUsageKey } from "../core/usage.js";
import type { KeyProvider, KeyPutResult, OrgView } from "../shared/protocol.js";
import type { PortalContext, Requester } from "./portal.js";

const SignupBody = z.object({
  orgName: z.string().max(200),
  name: z.string().max(200),
  email: z.string().max(254),
  password: z.string().max(1024),
  /** Honeypot: people never see this field; bots fill it in. */
  website: z.string().max(500).optional(),
});
const OrgPatchBody = z.object({ name: z.string().max(200) });
const OrgDeleteBody = z.object({ password: z.string().max(1024) });
const KeyBody = z.object({ key: z.string().max(4096) });
const PROVIDER = z.enum(["soniox"]);
const EMAIL = z.string().trim().toLowerCase().email().max(254);
const ENV_NAMES: Record<KeyProvider, string> = { soniox: "SONIOX_API_KEY" };

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function registerOrgApi(app: FastifyInstance, ctx: PortalContext): void {
  const keyChecks = new FailureRateLimiter({
    maxFailures: 20,
    windowMs: 60 * 60_000,
    blockMs: 60 * 60_000,
  });
  const { deps, hosted, fail, tooMany, storeError, orgOf, label } = ctx;
  const { users, screens, orgs, keys, usage, presets, auth, pages, log } = deps;
  const config = deps.loaded.config;

  /** This month's caption minutes and an estimate at the configured list prices. */
  const monthUsage = (orgId: string): OrgView["usage"] => {
    let minutes = 0;
    for (const row of usage.report().rows) {
      // Local mode is one organisation: every row is its own. Rows of other (removed) engines in
      // an older usage file are left out.
      if (hosted && row.keyId !== orgUsageKey(orgId)) continue;
      if (row.engine === "soniox") minutes += row.monthMinutes;
    }
    const p = config.pricing;
    const usd = (minutes / 60) * (p.sonioxSttPerHour + p.sonioxTranslationPerHour);
    return { monthMinutes: round(minutes, 1), estimateUsd: round(usd, 2) };
  };

  const orgView = (who: Requester, orgId: string): OrgView | null => {
    const org = orgs.get(orgId);
    if (org === undefined) return null;
    return {
      id: org.id,
      name: org.name,
      mode: config.mode,
      role: who.kind === "token" ? "admin" : who.user.role,
      keys: keys.status(orgId),
      usage: monthUsage(orgId),
    };
  };

  // --- sign-up (hosted) ---------------------------------------------------------------------------

  app.post("/api/auth/signup", async (req, reply) => {
    if (!hosted)
      return fail(reply, 404, "This server has no sign-up: ask its admin for an account");
    if (config.hosted.signup !== "open")
      return fail(reply, 403, "Sign-up is closed on this server");
    // The attempt counts while it runs, so a burst of parallel sign-ups cannot pass the limit.
    if (!deps.signupLimiter.tryBegin(req.ip)) {
      return tooMany(reply, Math.max(deps.signupLimiter.blockedFor(req.ip), 60_000));
    }
    // Sign-ups, honeypot hits and taken e-mail addresses count; mistakes in the form don't.
    let counted = false;
    try {
      return await signup(req, reply, () => {
        counted = true;
      });
    } finally {
      deps.signupLimiter.finish(req.ip, counted ? "failure" : "neutral");
    }
  });

  const signup = async (
    req: FastifyRequest,
    reply: FastifyReply,
    count: () => void,
  ): Promise<FastifyReply | { me: ReturnType<typeof toMe> }> => {
    const body = SignupBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, ctx.zodMessage(body.error));
    if ((body.data.website ?? "").trim() !== "") {
      count();
      log.warn({ ip: req.ip }, "portal: sign-up refused (honeypot)");
      return fail(reply, 400, "Sign-up failed");
    }
    const orgName = cleanOrgName(body.data.orgName);
    if (orgName === null) return fail(reply, 400, "Enter the name of your mosque or organisation");
    if (body.data.name.trim() === "") return fail(reply, 400, "Enter your name");
    const email = EMAIL.safeParse(body.data.email);
    if (!email.success) return fail(reply, 400, "Enter a valid e-mail address");
    const problem = ctx.passwordIssue(body.data.password);
    if (problem !== null) return fail(reply, 400, problem);
    if (users.byEmail(email.data) !== undefined) {
      count();
      return fail(reply, 409, "An account with this e-mail address exists already: log in");
    }
    const passwordHash = await hashPassword(body.data.password);
    let user: UserRecord;
    try {
      const org = orgs.create({ name: orgName });
      try {
        user = users.insert({
          username: ctx.usernameFor(email.data),
          displayName: body.data.name,
          role: "owner",
          passwordHash,
          orgId: org.id,
          email: normalizeEmail(email.data),
        });
      } catch (err) {
        orgs.remove(org.id);
        throw err;
      }
    } catch (err) {
      return storeError(reply, err);
    }
    // Every sign-up counts: at most 5 per address per hour.
    count();
    try {
      user = users.update(user.id, { lastLoginAt: Date.now() });
    } catch (err) {
      log.warn({ err }, "portal: could not record the login time");
    }
    auth.login(req, reply, user);
    log.info({ org: user.orgId, user: user.username, ip: req.ip }, "portal: sign-up");
    return reply.code(201).send({ me: toMe(user) });
  };

  // --- the organisation ---------------------------------------------------------------------------

  app.get("/api/org", async (req, reply) => {
    const who = ctx.requireLogin(req, reply);
    if (who === null) return reply;
    reply.header("Cache-Control", "no-store");
    return orgView(who, orgOf(who)) ?? fail(reply, 404, "No such organisation");
  });

  app.patch("/api/org", async (req, reply) => {
    const who = ctx.requireAdmin(req, reply);
    if (who === null) return reply;
    const body = OrgPatchBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, ctx.zodMessage(body.error));
    const orgId = orgOf(who);
    try {
      orgs.rename(orgId, body.data.name);
    } catch (err) {
      return storeError(reply, err);
    }
    log.info({ user: label(who), org: orgId }, "portal: organisation renamed");
    return orgView(who, orgId) ?? fail(reply, 404, "No such organisation");
  });

  // The owner deletes the organisation (hosted): its screens stop, then its presets, accounts,
  // keys and record are removed. Transcripts and usage numbers stay with the server.
  app.delete("/api/org", async (req, reply) => {
    const who = ctx.requireLogin(req, reply);
    if (who === null) return reply;
    if (!hosted)
      return fail(reply, 404, "A local server has one organisation; it cannot be deleted");
    if (who.kind !== "user" || who.user.role !== "owner") {
      return fail(reply, 403, "Only the owner can delete the organisation");
    }
    if (!deps.loginLimiter.tryBegin(req.ip)) {
      return tooMany(reply, Math.max(deps.loginLimiter.blockedFor(req.ip), 1000));
    }
    const body = OrgDeleteBody.safeParse(req.body ?? {});
    let right = false;
    try {
      if (!body.success) return fail(reply, 400, ctx.zodMessage(body.error));
      right = await verifyPassword(body.data.password, who.user.passwordHash);
    } finally {
      deps.loginLimiter.finish(req.ip, !body.success ? "neutral" : right ? "success" : "failure");
    }
    if (!right) return fail(reply, 403, "The password is wrong");
    // A presets.yaml with problems cannot be rewritten: stop before anything is half deleted.
    if (presets.problems.length > 0) {
      log.error({ org: who.user.orgId }, "portal: org delete refused, presets.yaml has problems");
      return fail(
        reply,
        409,
        "The server cannot delete this organisation right now; contact its operator",
      );
    }
    const orgId = who.user.orgId;
    let removedScreens: number;
    try {
      const gone = screens.removeOrg(orgId);
      removedScreens = gone.length;
      for (const screen of gone) {
        void pages.invalidateScreen(screen.id).catch((err: unknown) => {
          log.error({ err, screen: screen.id }, "portal: closing a deleted screen's pages failed");
        });
      }
      presets.removeOrg(orgId);
      users.removeOrg(orgId);
      orgs.remove(orgId);
    } catch (err) {
      return storeError(reply, err);
    }
    void pages.stopOrg(orgId).catch((err: unknown) => {
      log.error({ err, org: orgId }, "portal: stopping a deleted organisation's sessions failed");
    });
    auth.logout(req, reply);
    log.info({ user: label(who), org: orgId, screens: removedScreens }, "portal: org deleted");
    return reply.code(204).send();
  });

  // --- API keys -----------------------------------------------------------------------------------

  app.put<{ Params: { provider: string } }>("/api/org/keys/:provider", async (req, reply) => {
    const who = ctx.requireAdmin(req, reply);
    if (who === null) return reply;
    const provider = PROVIDER.safeParse(req.params.provider);
    if (!provider.success) return fail(reply, 404, "Unknown provider (soniox)");
    const body = KeyBody.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, ctx.zodMessage(body.error));
    const orgId = orgOf(who);
    // Every key check calls Soniox from this server: 20 per hour per address and per
    // organisation, accepted or not (and never the login limit, which a whole mosque shares).
    const orgSlot = `org-${orgId}`;
    if (!keyChecks.tryBegin(req.ip))
      return tooMany(reply, Math.max(keyChecks.blockedFor(req.ip), 60_000));
    if (!keyChecks.tryBegin(orgSlot)) {
      keyChecks.finish(req.ip, "neutral");
      return tooMany(reply, Math.max(keyChecks.blockedFor(orgSlot), 60_000));
    }
    const key = body.data.key.trim();
    let check: Awaited<ReturnType<typeof deps.checkKey>>;
    try {
      check = await deps.checkKey(provider.data, key);
    } finally {
      keyChecks.finish(req.ip, "failure");
      keyChecks.finish(orgSlot, "failure");
    }
    if (check.result === "rejected") {
      log.warn({ user: label(who), org: orgId, provider: provider.data }, "portal: key rejected");
      return fail(reply, 400, check.message);
    }
    let result: KeyPutResult;
    try {
      const status = keys.store(orgId, provider.data, key, {
        validated: check.result === "ok",
        by: who.kind === "user" ? who.user.id : null,
      });
      const warning =
        status.source === "env"
          ? `${ENV_NAMES[provider.data]} in the server's .env is used while it is set`
          : check.result === "unchecked"
            ? check.message
            : undefined;
      result = {
        status,
        checked: check.result === "ok",
        ...(warning === undefined ? {} : { warning }),
      };
    } catch (err) {
      if (err instanceof KeyStoreError) {
        log.error({ reason: err.message }, "portal: the master key is unusable");
        return fail(reply, 500, "This server cannot store keys: its master key is not valid");
      }
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), org: orgId, provider: provider.data, checked: result.checked },
      `portal: ${PROVIDER_NAMES[provider.data]} key stored`,
    );
    return result;
  });

  app.delete<{ Params: { provider: string } }>("/api/org/keys/:provider", async (req, reply) => {
    const who = ctx.requireAdmin(req, reply);
    if (who === null) return reply;
    const provider = PROVIDER.safeParse(req.params.provider);
    if (!provider.success) return fail(reply, 404, "Unknown provider (soniox)");
    const orgId = orgOf(who);
    let status: ReturnType<typeof keys.remove>;
    try {
      status = keys.remove(orgId, provider.data);
    } catch (err) {
      return storeError(reply, err);
    }
    log.info(
      { user: label(who), org: orgId, provider: provider.data },
      `portal: ${PROVIDER_NAMES[provider.data]} key removed`,
    );
    return { status };
  });
}
