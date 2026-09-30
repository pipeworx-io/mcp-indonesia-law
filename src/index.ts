interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Indonesian law — national statutes and regulations, and Constitutional Court
 * (Mahkamah Konstitusi) judicial-review outcomes, from two official
 * government legal-documentation portals (JDIH).
 *
 * Sources
 *   jdih.setneg.go.id — Kementerian Sekretariat Negara (State Secretariat).
 *     JSON API behind its Next.js front end: keyword search over the national
 *     regulation register (UU, Perpu, PP, Perpres, Keppres, Inpres), a per-
 *     instrument detail record (state-gazette numbers, promulgation dates,
 *     legal status), the amend/revoke/related graph, and the signed PDF copy.
 *   jdih.dpr.go.id — Sekretariat Jenderal DPR RI (House of Representatives).
 *     Per-statute abstracts with the Status list (what it amends/revokes, and
 *     which articles the Constitutional Court struck down), the implementing-
 *     regulation table, and the "Info Judicial Review" monographs that resume
 *     every Constitutional Court statute-review ruling — granted, rejected and
 *     inadmissible — with the case number and a PDF.
 *
 * Every tool is a live call per request; nothing is copied.
 *
 * Why not the courts' own sites: www.mkri.id (Constitutional Court) and
 * putusan3.mahkamahagung.go.id (Supreme Court decision directory) sit behind a
 * Cloudflare JavaScript challenge for every non-browser client, and
 * peraturan.go.id / jdihn.go.id refuse connections from outside Indonesia.
 * Details in README.md.
 *
 * DPR's front end answers HTTP 403 to a browser-shaped User-Agent from a
 * non-browser client and 200 to an honest bot UA — send ours, never spoof.
 */


const UA = 'pipeworx-mcp-indonesia-law/1.0 (+https://pipeworx.io)';
const SETNEG = 'https://jdih.setneg.go.id';
const DPR = 'https://jdih.dpr.go.id';
const DPR_SUFFIX = '-BAGIAN-PERTIMBANGAN-DAN-DOKUMENTASI-INFORMASI-HUKUM';

async function pwFetch(url: string | URL, init: RequestInit, upstream: string): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers, redirect: 'follow' }, upstream, 25_000);
}

// ---------------------------------------------------------------------------
// Small HTML helpers (the DPR portal is server-rendered HTML; no JSON there)
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&ldquo;|&rdquo;/g, '"');
}

function text(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function clean(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Setneg (Kementerian Sekretariat Negara) — JSON API
// ---------------------------------------------------------------------------

const SETNEG_TYPES: Record<string, string> = {
  UU: 'Undang-Undang (statute / act of parliament)',
  PERPU: 'Peraturan Pemerintah Pengganti Undang-Undang (government regulation in lieu of law)',
  PP: 'Peraturan Pemerintah (government regulation)',
  PERPRES: 'Peraturan Presiden (presidential regulation)',
  KEPPRES: 'Keputusan Presiden (presidential decree)',
  INPRES: 'Instruksi Presiden (presidential instruction)',
  PERMENSESNEG: 'Peraturan Menteri Sekretaris Negara (State Secretary ministerial regulation)',
  KEPMENSESNEG: 'Keputusan Menteri Sekretaris Negara (State Secretary ministerial decree)',
};

function normaliseType(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const t = String(v).trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (t === 'PERPPU') return 'PERPU';
  if (t === 'UNDANGUNDANG') return 'UU';
  return SETNEG_TYPES[t] ? t : t; // pass unknown through; upstream simply returns 0 rows
}

function toList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

interface SetnegRow {
  idperaturan: string;
  no_peraturan: string;
  tahun: string;
  tentang: string;
  jns: string;
  nama_jenis: string;
  files?: string;
  file_jj?: number;
  tgl_di?: string;
  diundangkan?: string;
  status_hukum?: string;
  ln?: number | string;
  tln?: number | string;
  status?: string;
  terkait?: string;
  mengubah?: string;
  mencabut?: string;
  diubah?: string;
  dicabut?: string;
  diubah_sebagian?: string;
  dicabut_sebagian?: string;
  mencabutsebagian?: string;
  mengubahsebagian?: string;
  keterangan?: string;
  bidang_hukum?: string;
  subjek?: string;
}

const LEGAL_STATUS_EN: Record<string, string> = {
  berlaku: 'in force',
  sebagian: 'partially amended or partially revoked',
  'tidak berlaku': 'no longer in force',
  dicabut: 'revoked',
  diubah: 'amended',
};

function pdfUrl(realName: string | undefined, id: string): string | null {
  if (!realName) return null;
  // The portal serves the signed copy through this endpoint; `fl` is the
  // register id it logs the download against.
  return `${SETNEG}/api/hukumproduk/pdf?l=uploads&f=${encodeURIComponent(realName)}&fl=${encodeURIComponent(id)}`;
}

function citation(jns: string, no: string, thn: string): string {
  return `${jns} ${no}/${thn}`;
}

function shapeSetnegRow(r: SetnegRow) {
  const status = clean(r.status_hukum).toLowerCase();
  return {
    id: r.idperaturan,
    citation: citation(r.jns, r.no_peraturan, r.tahun),
    type: r.jns,
    type_name: r.nama_jenis,
    number: r.no_peraturan,
    year: r.tahun,
    title: clean(r.tentang),
    legal_status: status || null,
    legal_status_en: LEGAL_STATUS_EN[status] ?? null,
    enacted: r.tgl_di ? r.tgl_di.slice(0, 10) : null,
    promulgated: r.diundangkan ? r.diundangkan.slice(0, 10) : null,
    pdf_url: pdfUrl(r.files?.replace(/^\d+\.\s*/, ''), r.idperaturan),
    detail_url: `${SETNEG}/detailperaturan?jns=${encodeURIComponent(r.jns)}&no=${encodeURIComponent(r.no_peraturan)}&thn=${encodeURIComponent(r.tahun)}`,
  };
}

async function setnegPost(path: string, body: unknown): Promise<unknown> {
  const res = await pwFetch(`${SETNEG}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, 'JDIH Setneg');
  if (!res.ok) throw new Error(`JDIH Setneg ${path} returned HTTP ${res.status}`);
  return res.json();
}

async function searchRegulations(args: Record<string, unknown>) {
  const query = clean(String(args.query ?? ''));
  const types = toList(args.type).map((t) => normaliseType(t)).filter((t): t is string => !!t);
  const years = toList(args.year);
  const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50);
  const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
  const status = clean(String(args.status ?? '')).toLowerCase();

  const body = {
    tentang: query,
    p_lihan: 'semua',
    jns: types,
    thn: years,
    status,
    terx: 'All',
    sortOrder: 'desc',
    length: limit,
    start: offset,
  };
  const data = (await setnegPost('/api/hukumproduk/produkhukum', body)) as { data?: SetnegRow[]; jml?: number };
  const rows = Array.isArray(data.data) ? data.data : [];
  const total = Number(data.jml ?? rows.length) || 0;
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_match',
      hint:
        'JDIH Setneg matches words in the Indonesian TITLE of the instrument. Use Indonesian terms ' +
        '("pajak" for tax, "kesehatan" for health, "cipta kerja"), drop the year filter, or leave query ' +
        'empty with type+year to list everything of that kind (e.g. {"type":"UU","year":"2023"}).',
      query,
      types,
      years,
      source: `${SETNEG}/produk-hukum/instrumen/peraturan`,
    };
  }
  return {
    found: true,
    total,
    offset,
    returned: rows.length,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
    query: query || null,
    types: types.length ? types : null,
    years: years.length ? years : null,
    results: rows.map(shapeSetnegRow),
    type_key: SETNEG_TYPES,
    source: `${SETNEG}/produk-hukum/instrumen/peraturan`,
    attribution: 'Kementerian Sekretariat Negara RI — JDIH (jdih.setneg.go.id)',
  };
}

// The status endpoint answers with HTML <label> chips; each chip carries the
// related instrument's id, type, number, year and title as data-attributes.
const LABEL_RE = /<label\b[^>]*\bid="(P\d+)"[^>]*\bstatus="([^"]*)"[^>]*\bdata-jns="([^"]*)"[^>]*\bdata-no="([^"]*)"[^>]*\bdata-thn="([^"]*)"[^>]*\bdata-original-title="([^"]*)"/g;

interface RelatedInstrument {
  id: string;
  citation: string;
  type: string;
  number: string;
  year: string;
  title: string;
  in_register: boolean;
}

function collectLabels(v: unknown, out: RelatedInstrument[] = []): RelatedInstrument[] {
  if (typeof v === 'string') {
    for (const m of v.matchAll(LABEL_RE)) {
      out.push({
        id: m[1],
        citation: citation(m[3], m[4], m[5]),
        type: m[3],
        number: m[4],
        year: m[5],
        title: decodeEntities(m[6]).trim(),
        in_register: m[2] !== 'diluar',
      });
    }
  } else if (Array.isArray(v)) {
    for (const x of v) collectLabels(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectLabels(x, out);
  }
  return out;
}

async function regulationDetail(args: Record<string, unknown>) {
  const jns = normaliseType(args.type);
  const no = clean(String(args.number ?? ''));
  const thn = clean(String(args.year ?? ''));
  if (!jns || !no || !thn) {
    return {
      found: false,
      reason: 'missing_argument',
      hint: 'Pass type, number and year, e.g. {"type":"UU","number":"11","year":"2020"} for Undang-Undang 11/2020 (Cipta Kerja). Find them with idn_search_regulations.',
    };
  }
  const detail = (await setnegPost('/api/hukumproduk/detaildata', { jns, no, thn, k: '' })) as {
    row?: SetnegRow[];
    file?: { name?: string; size?: number; ext?: string; realName?: string }[];
  };
  const row = detail.row?.[0];
  if (!row) {
    return {
      found: false,
      reason: 'not_in_register',
      hint: `JDIH Setneg has no ${citation(jns, no, thn)}. Check the number/year with idn_search_regulations, or try the DPR register via idn_list_statutes + idn_statute_detail.`,
      source: `${SETNEG}/detailperaturan?jns=${jns}&no=${no}&thn=${thn}`,
    };
  }
  const o = (s: string | undefined) => s ?? '';
  // The detail record carries no legal status; the search endpoint does. Ask
  // for the relations graph and the same type+year's listing side by side.
  const [relations, listing] = await Promise.all([
    setnegPost('/api/hukumproduk/status', {
      idx: row.idperaturan,
      dc: o(row.dicabut),
      dcs: o(row.dicabut_sebagian),
      dd: o(row.diubah),
      dds: o(row.diubah_sebagian),
      dm: o(row.mencabut),
      dms: o(row.mencabutsebagian),
      dme: o(row.mengubah),
      dmes: o(row.mengubahsebagian),
      dt: o(row.terkait),
    }).catch(() => null) as Promise<Record<string, unknown> | null>,
    setnegPost('/api/hukumproduk/produkhukum', {
      tentang: '', p_lihan: 'semua', jns: [jns], thn: [thn], status: '', terx: 'All', sortOrder: 'desc', length: 500, start: 0,
    }).catch(() => null) as Promise<{ data?: SetnegRow[] } | null>,
  ]);
  const rel = relations ?? {};
  const listed = listing?.data?.find((r) => r.no_peraturan === row.no_peraturan) ?? null;
  const files = (detail.file ?? []).map((f) => ({
    name: f.name ?? f.realName ?? null,
    size_bytes: f.size ?? null,
    url: pdfUrl(f.realName ?? f.name, row.idperaturan),
  }));
  const status = clean(listed?.status_hukum).toLowerCase();
  return {
    found: true,
    ...shapeSetnegRow(row),
    pdf_url: files[0]?.url ?? null,
    register_status: row.status || null,
    legal_status: status || null,
    legal_status_en: LEGAL_STATUS_EN[status] ?? null,
    state_gazette: { ln: row.ln ?? null, tln: row.tln ?? null },
    legal_field: clean(row.bidang_hukum) || null,
    subject: clean(row.subjek) || null,
    note: clean(row.keterangan) || null,
    files,
    relations: {
      revoked_by: collectLabels(rel.dc),
      partially_revoked_by: collectLabels(rel.dcs),
      amended_by: collectLabels(rel.du),
      partially_amended_by: collectLabels(rel.dus),
      revokes: collectLabels(rel.mc),
      partially_revokes: collectLabels(rel.mcs),
      amends: collectLabels(rel.me),
      partially_amends: collectLabels(rel.mes),
      related: collectLabels(rel.tk),
      judicial_review: collectLabels(rel.ujimateri),
    },
    relations_note:
      'Relations come from the Setneg register. For which ARTICLES the Constitutional Court struck down, and the implementing regulations per article, use idn_statute_detail (DPR register).',
    source: `${SETNEG}/detailperaturan?jns=${jns}&no=${no}&thn=${thn}`,
    attribution: 'Kementerian Sekretariat Negara RI — JDIH (jdih.setneg.go.id)',
  };
}

// ---------------------------------------------------------------------------
// DPR (Sekretariat Jenderal DPR RI) — server-rendered HTML
// ---------------------------------------------------------------------------

const DPR_TYPES: Record<string, { slug: string; name: string }> = {
  uu: { slug: 'Undang-undang', name: 'Undang-Undang (statute)' },
  perpu: { slug: 'Peraturan-Pemerintah-Pengganti-Undang-undang', name: 'Perpu (government regulation in lieu of law)' },
  pp: { slug: 'Peraturan-Pemerintah', name: 'Peraturan Pemerintah (government regulation)' },
  perpres: { slug: 'Peraturan-Presiden', name: 'Peraturan Presiden (presidential regulation)' },
  keppres: { slug: 'Keputusan-Presiden', name: 'Keputusan Presiden (presidential decree)' },
  inpres: { slug: 'Instruksi-Presiden', name: 'Instruksi Presiden (presidential instruction)' },
  perdpr: { slug: 'Peraturan-DPR', name: 'Peraturan DPR (House regulation)' },
  peraturanbersama: { slug: 'Peraturan-Bersama', name: 'Peraturan Bersama (joint regulation)' },
};

async function dprGet(path: string): Promise<string> {
  const res = await pwFetch(`${DPR}${path}`, { headers: { Accept: 'text/html' } }, 'JDIH DPR RI');
  if (!res.ok) throw new Error(`JDIH DPR RI ${path} returned HTTP ${res.status}`);
  return res.text();
}

function dprType(v: unknown): string {
  const t = String(v ?? 'uu').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'perppu') return 'perpu';
  if (t === 'undangundang') return 'uu';
  return t;
}

const DPR_ROW_RE = /<a href='\/setjen\/detail-dokumen\/tipe\/([a-z0-9]+)\/id\/(\d+)'>([\s\S]*?)<\/a>[\s\S]*?(?:href="(https:\/\/berkas\.dpr\.go\.id\/[^"]+\.pdf)"|<\/tr>)/g;

async function listStatutes(args: Record<string, unknown>) {
  const type = dprType(args.type);
  const def = DPR_TYPES[type];
  if (!def) {
    return {
      found: false,
      reason: 'unknown_type',
      hint: `type must be one of ${Object.keys(DPR_TYPES).join(', ')}.`,
    };
  }
  const year = clean(String(args.year ?? ''));
  const query = clean(String(args.query ?? '')).toLowerCase();
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
  const path = `/setjen/index/id/${def.slug}${DPR_SUFFIX}${year ? `/year/${encodeURIComponent(year)}` : ''}`;
  const html = await dprGet(path);
  const rows: { dpr_id: string; type: string; title: string; detail_url: string; pdf_url: string | null }[] = [];
  for (const m of html.matchAll(DPR_ROW_RE)) {
    rows.push({
      dpr_id: m[2],
      type: m[1],
      title: text(m[3]),
      detail_url: `${DPR}/setjen/detail-dokumen/tipe/${m[1]}/id/${m[2]}`,
      pdf_url: m[4] ?? null,
    });
  }
  const terms = query.split(/\s+/).filter(Boolean);
  const filtered = terms.length ? rows.filter((r) => terms.every((t) => r.title.toLowerCase().includes(t))) : rows;
  if (filtered.length === 0) {
    return {
      found: false,
      reason: rows.length === 0 ? 'no_rows_for_year' : 'no_title_match',
      hint:
        rows.length === 0
          ? `DPR lists no ${def.name} for ${year || 'the default view'}. Perpu and Peraturan DPR are sparse — try another year, or idn_search_regulations for the Setneg register.`
          : `No ${def.name} title in ${year || 'the default view'} contains "${query}". Titles are Indonesian; try an Indonesian word, or drop the query to see all ${rows.length}.`,
      source: `${DPR}${path}`,
    };
  }
  return {
    found: true,
    type,
    type_name: def.name,
    year: year || null,
    note: year ? null : 'No year given: DPR shows only its newest handful. Pass year for the full list of that year.',
    total_on_page: rows.length,
    returned: Math.min(filtered.length, limit),
    results: filtered.slice(0, limit),
    source: `${DPR}${path}`,
    attribution: 'Sekretariat Jenderal DPR RI — JDIH (jdih.dpr.go.id)',
  };
}

function metaTable(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<tr>\s*<th>([^<]*)<\/th>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    const k = clean(m[1]);
    if (!k || k in out) continue;
    out[k] = text(m[2]);
  }
  return out;
}

function listBlock(html: string, title: string): string[] {
  const re = new RegExp(`<div class="stitle">${title}</div>\\s*<ul class="custom-button">([\\s\\S]*?)</ul>`);
  const m = html.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => text(x[1])).filter(Boolean);
}

const MK_CASE_RE = /(\d+)\s*\/\s*PUU\s*[-/]\s*([IVXLC]+)\s*\/\s*(\d{4})/i;

function caseNumber(s: string): string | null {
  const m = s.match(MK_CASE_RE);
  return m ? `${m[1]}/PUU-${m[2].toUpperCase()}/${m[3]}` : null;
}

function parseStatusLine(line: string) {
  // "Mengubah UU - Undang-Undang Nomor 26 Tahun 2007 tentang Penataan Ruang"
  // "Dicabut Putusan Mahkamah Konstitusi - No. 19/PUU-IX/2011, Pasal 164 ayat (3) ..."
  const m = line.match(/^(Mencabut|Dicabut|Mengubah|Diubah|Menetapkan|Ditetapkan|Mencabut Sebagian|Dicabut Sebagian|Mengubah Sebagian|Diubah Sebagian)\s+(.*?)\s+-\s+([\s\S]*)$/i);
  const relation = m ? m[1] : null;
  const instrument = m ? clean(m[2]) : null;
  const description = m ? clean(m[3]) : clean(line);
  const isMk = /mahkamah konstitusi/i.test(instrument ?? '') || /PUU/i.test(description);
  const REL_EN: Record<string, string> = {
    mencabut: 'revokes',
    dicabut: 'revoked by',
    mengubah: 'amends',
    diubah: 'amended by',
    menetapkan: 'enacts',
    ditetapkan: 'enacted by',
  };
  const articles = [...description.matchAll(/Pasal\s+\d+[A-Z]?(?:\s+ayat\s+\(\d+\))?(?:\s+huruf\s+[a-z])?/gi)].map((x) => clean(x[0]));
  return {
    relation,
    relation_en: relation ? REL_EN[relation.toLowerCase().split(' ')[0]] ?? null : null,
    instrument,
    description,
    constitutional_court: isMk,
    case_number: isMk ? caseNumber(description) : null,
    articles: articles.length ? [...new Set(articles)] : undefined,
  };
}

function parsePerlak(html: string) {
  const i = html.indexOf('Peraturan Pelaksanaan (Perlak)');
  if (i < 0) return [];
  const seg = html.slice(i);
  const end = seg.indexOf('</table>');
  const table = end > 0 ? seg.slice(0, end) : seg;
  const rows: { article: string; regulation: string; about: string }[] = [];
  for (const m of table.matchAll(/<tr class="list">([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]));
    if (cells.length >= 4) rows.push({ article: clean(cells[1]), regulation: clean(cells[2]), about: clean(cells[3]) });
  }
  return rows;
}

async function statuteDetail(args: Record<string, unknown>) {
  const type = dprType(args.type);
  const id = clean(String(args.dpr_id ?? args.id ?? '')).replace(/\D/g, '');
  if (!id) {
    return {
      found: false,
      reason: 'missing_argument',
      hint: 'Pass the DPR register id from idn_list_statutes, e.g. {"type":"uu","dpr_id":"1771"} (Undang-Undang 11/2020 Cipta Kerja).',
    };
  }
  const path = `/setjen/detail-dokumen/tipe/${encodeURIComponent(type)}/id/${id}`;
  const html = await dprGet(path);
  const meta = metaTable(html);
  if (!meta.Nomor && !meta.Tahun) {
    return {
      found: false,
      reason: 'not_found',
      hint: `DPR has no ${type} with id ${id}. Ids are per type — get them from idn_list_statutes.`,
      source: `${DPR}${path}`,
    };
  }
  // The document title is the <h1> inside the body content; the header <h1>
  // above it is the portal's own name on every page.
  const bodyAt = html.indexOf('class="body-content');
  const h1 = html.slice(bodyAt < 0 ? 0 : bodyAt).match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const rawAbstract = (meta.Abstrak ?? '').replace(/\s*UNDUH ABSTRAK\s*$/i, '');
  const [abstractPart, notesPart] = rawAbstract.split(/\n?CATATAN\s*:\s*/i);
  const status = listBlock(html, 'Status').map(parseStatusLine);
  const pdf = html.match(/href="(https:\/\/berkas\.dpr\.go\.id\/jdih\/document\/[a-z0-9]+\/\d+\.pdf[^"]*)"/);
  const mk = status.filter((s) => s.constitutional_court);
  const typeName = DPR_TYPES[type]?.name ?? type.toUpperCase();
  return {
    found: true,
    dpr_id: id,
    type,
    type_name: typeName,
    citation: `${type.toUpperCase()} ${meta.Nomor ?? '?'}/${meta.Tahun ?? '?'}`,
    title: text(h1?.[1] ?? '') || null,
    number: meta.Nomor ?? null,
    year: meta.Tahun ?? null,
    enacted: meta['Tanggal Penetapan'] ?? null,
    promulgated: meta['Tanggal Pengundangan'] ?? null,
    abstract: clean(abstractPart) || null,
    notes: notesPart
      ? notesPart.split(/\n?-\s+/).map((s) => clean(s)).filter(Boolean)
      : [],
    fields: listBlock(html, 'Bidang'),
    status,
    constitutional_court_rulings: mk.map((s) => ({
      case_number: s.case_number,
      articles: s.articles ?? [],
      effect: s.description,
    })),
    implementing_regulations: parsePerlak(html),
    pdf_url: pdf ? pdf[1].split('?')[0] : null,
    source: `${DPR}${path}`,
    attribution: 'Sekretariat Jenderal DPR RI — JDIH (jdih.dpr.go.id)',
  };
}

// --- Constitutional Court judicial-review resumes (DPR monographs) -----------

const MK_CATEGORIES: Record<string, { slug: string; label: string }> = {
  granted: {
    slug: 'Info-Judicial-Review-Putusan-MK---Menyatakan-Mengabulkan',
    label: 'Constitutional Court GRANTED the petition (statute or article declared unconstitutional / conditionally unconstitutional)',
  },
  rejected: {
    slug: 'Resume-Putusan-MK---Menyatakan-Menolak,-Tidak-Dapat-Diterima',
    label: 'Constitutional Court REJECTED the petition or declared it inadmissible',
  },
  analysis: {
    slug: 'Analisis-dan-Evaluasi-UU-Berdasarkan-Putusan-MK',
    label: 'DPR analysis and evaluation of a statute following Constitutional Court rulings',
  },
  dpr_statement: {
    slug: 'Keterangan-DPR-mengenai-Pengujian-UU-Terhadap-UUD-1945',
    label: 'DPR statement (keterangan) submitted in a judicial-review case',
  },
};

interface MkRow {
  category: string;
  category_label: string;
  year: string;
  title: string;
  case_number: string | null;
  reviewed_statute: string | null;
  url: string;
}

const MK_LIST_TTL_MS = 6 * 60 * 60 * 1000;
const mkListCache = new Map<string, { at: number; rows: MkRow[] }>();

async function mkList(category: string): Promise<MkRow[]> {
  const hit = mkListCache.get(category);
  const now = Date.now();
  if (hit && now - hit.at < MK_LIST_TTL_MS) return hit.rows;
  const def = MK_CATEGORIES[category];
  const html = await dprGet(`/setjen/index/id/${def.slug}${DPR_SUFFIX}`);
  const rows: MkRow[] = [];
  for (const tr of html.split('<tr>').slice(1)) {
    const year = tr.match(/<div class='text cell'>(\d{4})<\/div>/);
    const href = tr.match(/href="(\/setjen\/view\/[^"]+)"/);
    const cells = [...tr.matchAll(/<div class='text cell'>([\s\S]*?)<\/div>/g)].map((c) => text(c[1]));
    if (!href || cells.length < 2) continue;
    const title = cells.find((c) => c.length > 20) ?? cells[cells.length - 1];
    const st = title.match(/UNDANG-UNDANG\s+NOMOR\s+(\d+)\s+TAHUN\s+(\d{4})/i);
    rows.push({
      category,
      category_label: def.label,
      year: year ? year[1] : '',
      title,
      case_number: caseNumber(title),
      reviewed_statute: st ? `UU ${st[1]}/${st[2]}` : null,
      url: `${DPR}${href[1]}`,
    });
  }
  if (rows.length) mkListCache.set(category, { at: now, rows });
  return rows;
}

async function mkReviewSearch(args: Record<string, unknown>) {
  const query = clean(String(args.query ?? ''));
  const cat = clean(String(args.category ?? 'all')).toLowerCase();
  const categories = cat === 'all' || !cat ? Object.keys(MK_CATEGORIES) : cat.split(',').map((c) => c.trim()).filter((c) => MK_CATEGORIES[c]);
  if (categories.length === 0) {
    return { found: false, reason: 'unknown_category', hint: `category must be all or one of ${Object.keys(MK_CATEGORIES).join(', ')}.` };
  }
  const year = clean(String(args.year ?? ''));
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 200);
  const lists = await Promise.all(categories.map((c) => mkList(c)));
  let rows = lists.flat();
  const scanned = rows.length;
  if (year) rows = rows.filter((r) => r.year === year || r.case_number?.endsWith(`/${year}`));
  const wantedCase = caseNumber(query);
  if (wantedCase) {
    rows = rows.filter((r) => r.case_number === wantedCase);
  } else if (query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => terms.every((t) => r.title.toLowerCase().includes(t)));
  }
  rows.sort((a, b) => (b.year || '').localeCompare(a.year || ''));
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_match',
      scanned,
      hint:
        'Titles are Indonesian and name the statute under review ("UNDANG-UNDANG NOMOR 13 TAHUN 2003 TENTANG KETENAGAKERJAAN"). ' +
        'Search by case number (e.g. "91/PUU-XVIII/2020"), by statute words ("ketenagakerjaan", "pemilihan umum"), or by "nomor 13 tahun 2003". ' +
        'These resumes cover statute-review (PUU) rulings that DPR documented; the Court itself publishes the full text at www.mkri.id.',
      sources: categories.map((c) => `${DPR}/setjen/index/id/${MK_CATEGORIES[c].slug}${DPR_SUFFIX}`),
    };
  }
  return {
    found: true,
    total_matches: rows.length,
    scanned,
    categories,
    returned: Math.min(rows.length, limit),
    results: rows.slice(0, limit),
    next_step: 'Pass a result url to idn_mk_review_detail for the resume PDF and metadata.',
    sources: categories.map((c) => `${DPR}/setjen/index/id/${MK_CATEGORIES[c].slug}${DPR_SUFFIX}`),
    attribution: 'Sekretariat Jenderal DPR RI — Pusat Pemantauan Pelaksanaan Undang-Undang, via JDIH (jdih.dpr.go.id)',
  };
}

async function mkReviewDetail(args: Record<string, unknown>) {
  let url = clean(String(args.url ?? args.slug ?? ''));
  if (!url) {
    return { found: false, reason: 'missing_argument', hint: 'Pass the url (or the slug after /setjen/view/) from an idn_mk_review_search result.' };
  }
  if (!/^https?:\/\//.test(url)) url = `${DPR}/setjen/view/${url.replace(/^\/?setjen\/view\//, '')}`;
  if (!url.startsWith(`${DPR}/setjen/view/`)) {
    return { found: false, reason: 'not_a_dpr_view_url', hint: `url must start with ${DPR}/setjen/view/` };
  }
  const html = await dprGet(url.slice(DPR.length));
  const meta = metaTable(html);
  if (!meta.Judul) {
    return { found: false, reason: 'not_found', hint: 'DPR returned a page without a Judul (title) field — the slug may have changed. Re-run idn_mk_review_search.', source: url };
  }
  const pdf = html.match(/href="(https:\/\/berkas\.dpr\.go\.id\/[^"]+\.pdf[^"]*)"/);
  const origin = html.match(/<th>Website Asal<\/th>\s*<td>[\s\S]*?href="([^"]+)"/);
  const title = meta.Judul;
  const st = title.match(/UNDANG-UNDANG\s+NOMOR\s+(\d+)\s+TAHUN\s+(\d{4})/i);
  return {
    found: true,
    title,
    document_kind: meta.Jenis ?? null,
    case_number: caseNumber(title),
    reviewed_statute: st ? `UU ${st[1]}/${st[2]}` : null,
    published_year: meta['Tahun Terbit'] ?? null,
    legal_field: meta['Bidang Hukum'] ?? null,
    language: meta.Bahasa ?? null,
    author: meta['TEU Orang/Badan'] ?? null,
    pdf_url: pdf ? pdf[1] : null,
    origin_url: origin ? origin[1] : null,
    source: url,
    attribution: 'Sekretariat Jenderal DPR RI — Pusat Pemantauan Pelaksanaan Undang-Undang, via JDIH (jdih.dpr.go.id)',
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'idn_search_regulations',
    description:
      'Search Indonesia\'s national register of laws and regulations (Undang-Undang statutes, Perpu, Peraturan Pemerintah, Peraturan Presiden, Keppres, Inpres) by Indonesian title words, instrument type and year. Returns each instrument\'s citation, title, legal status (in force / partially amended / revoked), enactment and promulgation dates and a link to the signed PDF, from the State Secretariat JDIH (jdih.setneg.go.id). Use for "what Indonesian laws exist about X", "list Indonesian statutes passed in 2023", "is UU 11/2020 Cipta Kerja still in force".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Indonesian words expected in the instrument\'s title, e.g. "cipta kerja", "pajak", "kesehatan", "mahkamah konstitusi". Optional; leave empty to list by type and year.' },
        type: { type: 'string', description: 'Instrument type or comma-separated types: UU, PERPU, PP, PERPRES, KEPPRES, INPRES, PERMENSESNEG, KEPMENSESNEG. Optional.' },
        year: { type: 'string', description: 'Four-digit year or comma-separated years, e.g. "2023" or "2021,2022". Optional.' },
        status: { type: 'string', description: 'Legal-status filter as the register spells it: "berlaku" (in force), "sebagian" (partially amended/revoked), "tidak berlaku" (no longer in force). Optional.' },
        limit: { type: 'number', description: 'Results per page, 1-50 (default 10).' },
        offset: { type: 'number', description: 'Row offset for paging (default 0).' },
      },
      required: [],
    },
  },
  {
    name: 'idn_regulation_detail',
    description:
      'Full register record for one Indonesian law or regulation by type, number and year: title, legal status, state gazette (Lembaran Negara / Tambahan) numbers, dates, the signed PDF, and its relations — which instruments amend or revoke it, which it amends or revokes, related implementing regulations and any judicial-review entry — from the State Secretariat JDIH (jdih.setneg.go.id). Use for "details of UU 6/2023", "what amended PP 5/2021", "get the PDF of Perpres 40/2026".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Instrument type: UU, PERPU, PP, PERPRES, KEPPRES, INPRES, PERMENSESNEG or KEPMENSESNEG.' },
        number: { type: 'string', description: 'Instrument number, e.g. "11".' },
        year: { type: 'string', description: 'Four-digit year, e.g. "2020".' },
      },
      required: ['type', 'number', 'year'],
    },
  },
  {
    name: 'idn_list_statutes',
    description:
      'List Indonesian statutes and executive instruments by type and year from the House of Representatives (DPR RI) legal register — Undang-Undang, Perpu, Peraturan Pemerintah, Peraturan Presiden, Keputusan Presiden, Instruksi Presiden, Peraturan DPR — with the DPR id needed by idn_statute_detail and a direct PDF link, optionally filtered by Indonesian title words. Use for "all Indonesian laws enacted in 2020", "presidential regulations of 2024 about energy".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'One of: uu, perpu, pp, perpres, keppres, inpres, perdpr, peraturanbersama (default uu).' },
        year: { type: 'string', description: 'Four-digit year, e.g. "2020". Strongly recommended — without it DPR shows only its newest few.' },
        query: { type: 'string', description: 'Indonesian words that must all appear in the title, e.g. "mineral batubara". Optional.' },
        limit: { type: 'number', description: 'Max rows to return, 1-500 (default 50).' },
      },
      required: [],
    },
  },
  {
    name: 'idn_statute_detail',
    description:
      'Detailed record of one Indonesian statute or executive instrument from the House of Representatives (DPR RI) register: number, year, enactment/promulgation dates, an Indonesian abstract with drafting notes, the responsible DPR commission, the Status list (which earlier laws it amends or revokes, which later laws amend it, and which ARTICLES the Constitutional Court / Mahkamah Konstitusi struck down, with case numbers), the table of implementing regulations per article, and the PDF. Use for "which articles of UU 13/2003 were annulled by the Constitutional Court", "implementing regulations of the Cipta Kerja law", "abstract of UU 1/2026".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'One of: uu, perpu, pp, perpres, keppres, inpres, perdpr (default uu).' },
        dpr_id: { type: 'string', description: 'DPR register id from idn_list_statutes, e.g. "1771" (UU 11/2020 Cipta Kerja) or "196" (UU 13/2003 Ketenagakerjaan).' },
      },
      required: ['dpr_id'],
    },
  },
  {
    name: 'idn_mk_review_search',
    description:
      'Find Indonesian Constitutional Court (Mahkamah Konstitusi, MK) judicial-review outcomes on statutes — petitions granted (article declared unconstitutional), rejected or inadmissible, plus DPR\'s post-ruling analyses and its statements in the case — by case number (e.g. 91/PUU-XVIII/2020), by Indonesian statute words, or by year, from the DPR RI "Info Judicial Review" resume collection (800+ documents). Returns the case number, the statute under review, the outcome category and a link for idn_mk_review_detail. Use for "Constitutional Court rulings on the election law", "was the petition against UU 11/2020 granted", "MK decisions in 2023".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Case number like "21/PUU-XXI/2023", or Indonesian words from the statute title, e.g. "pemilihan umum", "ketenagakerjaan", "nomor 13 tahun 2003". Optional.' },
        category: { type: 'string', description: 'all (default), granted, rejected, analysis, dpr_statement — or a comma-separated subset.' },
        year: { type: 'string', description: 'Four-digit year of the ruling/publication, e.g. "2023". Optional.' },
        limit: { type: 'number', description: 'Max results, 1-200 (default 20).' },
      },
      required: [],
    },
  },
  {
    name: 'idn_mk_review_detail',
    description:
      'Metadata and PDF for one Indonesian Constitutional Court judicial-review resume or DPR analysis document from the DPR RI register, given the url returned by idn_mk_review_search: full title, document kind, MK case number, statute under review, publication year and the resume PDF from berkas.dpr.go.id. Use after idn_mk_review_search to read the ruling summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'A jdih.dpr.go.id/setjen/view/... url from idn_mk_review_search (the slug after /setjen/view/ also works).' },
      },
      required: ['url'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'idn_search_regulations':
      return searchRegulations(args);
    case 'idn_regulation_detail':
      return regulationDetail(args);
    case 'idn_list_statutes':
      return listStatutes(args);
    case 'idn_statute_detail':
      return statuteDetail(args);
    case 'idn_mk_review_search':
      return mkReviewSearch(args);
    case 'idn_mk_review_detail':
      return mkReviewDetail(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
