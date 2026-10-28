/**
 * What each Meld provider reports for a purchase, and when, against a real Meld account.
 *
 * The worker learns a buy's progress only by polling Meld for the transaction filed under the
 * request's reference (`src/meld/rail.ts`), and maps whatever status comes back onto the funding
 * lifecycle. Meld forwards each provider's statuses as they are, so which statuses arrive, in what
 * order and how far apart differs per provider, and the sandbox is the only place to watch it
 * without real money. This opens a BUY session per case exactly as `createWidgetSession` does,
 * and while someone pays in the widget with the provider's sandbox test details it polls the
 * transaction three ways: by the reference, as the worker does, and by Meld's session id, through
 * the per-session path and the `sessionIds` filter. Every change is logged with the seconds since
 * the session opened, Meld's own timestamps, any status-like field the provider adds, and the
 * state the worker would record. A transaction only the session-id lookups find is one the worker
 * never sees, and is flagged.
 *
 * Typing a note and Enter while a case is watched puts the moment in its timeline ("submitted the
 * card"); `n` and Enter moves on to the next case.
 *
 * `--sessions N` needs no one at the keyboard: it opens N sessions per case, pays none, and counts
 * how often Meld refuses one, which is the evidence for or against retrying a refusal.
 *
 * Run: `MELD_API_KEY_FILE=<path> npm run meld:statuses -- [flags]`. The key is read from
 * `MELD_API_KEY` or the file `MELD_API_KEY_FILE` names, and is never printed. Results go to a new
 * directory under the system temp dir (`--out` to choose): `statuses.md`, `statuses.json`, and
 * `events.jsonl` with every poll that changed something, raw. The raw transactions carry what was
 * typed into the widget, so keep them out of the repository.
 *
 * Flags:
 *   --cases      PROVIDER:METHOD:COUNTRY, comma separated; METHOD is a Meld payment method code
 *                (CREDIT_DEBIT_CARD, SEPA, OPEN_BANKING, ...), `card` for CREDIT_DEBIT_CARD
 *   --crypto     the destination code (default USDT_DOT)
 *   --wallet     the address the purchase delivers to (default: a Polkadot Asset Hub address)
 *   --client-ip  send `clientIpAddress` with the session, which some providers require
 *   --open       open each widget in the default browser (macOS `open`)
 *   --watch      minutes to watch one case at most (default 20)
 *   --interval   seconds between polls (default 2)
 *   --linger     seconds to keep watching after a terminal status (default 60)
 *   --retries    extra tries when Meld refuses a session in a watched run (default 2)
 *   --sessions   sessions to open per case, unwatched
 *   --stdin      read notes from a pipe rather than a terminal
 *   --env        sandbox (default) or production; --base overrides the URL, for a stand-in
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const has = (name) => args.includes(`--${name}`);

const ENV = flag('env', 'sandbox');
const BASE = flag('base', ENV === 'production' ? 'https://api.meld.io' : 'https://api-sb.meld.io');
// The version `meld.api_version` carries in `config.example.json`.
const VERSION = flag('version', '2025-01-01');
const CRYPTO = flag('crypto', 'USDT_DOT');
const WALLET = flag('wallet', '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5');
const CLIENT_IP = flag('client-ip', undefined);
// Where the widget should send the buyer when done: a provider that honours it lands here.
const REDIRECT = flag('redirect', 'https://example.com/meld-statuses-return');
const WATCH_MS = Number(flag('watch', '20')) * 60_000;
const INTERVAL_MS = Number(flag('interval', '2')) * 1000;
const LINGER_MS = Number(flag('linger', '60')) * 1000;
const RETRIES = Number(flag('retries', '2'));
const SESSIONS = has('sessions') ? Number(flag('sessions', '5')) : 0;
const OPEN = has('open');
const METHOD_ALIASES = { card: 'CREDIT_DEBIT_CARD' };
const CASES = flag('cases', 'BANXA:card:DE,BANXA:SEPA:DE,TRANSAK:card:US,TRANSAK:OPEN_BANKING:GB')
  .split(',')
  .map((c) => {
    const [provider = '', method = '', country = ''] = c.trim().split(':');
    return {
      provider: provider.toUpperCase(),
      method: METHOD_ALIASES[method] ?? method.toUpperCase(),
      country: country.toUpperCase(),
    };
  });

const KEY = (() => {
  const inline = process.env.MELD_API_KEY?.trim();
  if (inline) return inline;
  const file = process.env.MELD_API_KEY_FILE;
  return file ? readFileSync(file, 'utf8').trim() || null : null;
})();
if (!KEY) {
  console.error('Set MELD_API_KEY_FILE (or MELD_API_KEY) to the Meld key.');
  process.exit(1);
}

const STAMP = new Date().toISOString().slice(0, 16).replace(':', '');
const OUT = flag('out', join(tmpdir(), `meld-statuses-${ENV}-${SESSIONS ? 'sessions-' : ''}${STAMP}`));
mkdirSync(OUT, { recursive: true });
const record = (event) =>
  appendFileSync(join(OUT, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');

// --- Meld --------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Meld call, a 429 waited out. The key travels only in the header; no header is logged. */
async function meld(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = {
      'Meld-Version': VERSION,
      Accept: 'application/json',
      // Meld's scheme: the word BASIC, then the key, as `MeldClient` sends it.
      Authorization: `BASIC ${KEY}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === 5) return { ok: false, status: 0, json: null, text: String(error) };
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: `text` carries it.
    }
    return { ok: res.ok, status: res.status, json, text };
  }
  return { ok: false, status: 429, json: null, text: 'rate limited' };
}

const why = (r) => `HTTP ${String(r.status)} ${r.json?.code ?? ''} ${r.json?.message ?? r.text.slice(0, 160)}`.trim();

/** The provider's bounds for the method in `fiat`, from this account's routes. */
async function routeFor({ provider, country, fiat, method }) {
  const r = await meld(`/network-partner/supported/routes/CRYPTO_ONRAMP/${country}/${fiat}/${CRYPTO}`);
  for (const route of Array.isArray(r.json) ? r.json : []) {
    if (route.partner !== provider) continue;
    const m = (route.paymentMethods ?? []).find((x) => x.name === method);
    if (m) return { min: Number(m.limits?.min), max: Number(m.limits?.max), currency: m.limits?.currencyCode };
  }
  return null;
}

/** Just above the route's minimum, inside its maximum; 50 when the route names no bound. */
function amountFor(route, fiat) {
  if (!route || route.currency !== fiat || !Number.isFinite(route.min)) return 50;
  const amount = Math.ceil(Math.max(route.min * 1.1, route.min + 1));
  return Number.isFinite(route.max) ? Math.min(amount, route.max) : amount;
}

async function quote({ provider, country, fiat, method, amount }) {
  const r = await meld('/payments/crypto/quote', {
    method: 'POST',
    body: {
      countryCode: country,
      sourceCurrencyCode: fiat,
      sourceAmount: amount.toFixed(2),
      destinationCurrencyCode: CRYPTO,
      paymentMethodType: method,
      serviceProviders: [provider],
    },
  });
  const lines = (Array.isArray(r.json) ? r.json : (r.json?.quotes ?? [])).filter(
    (q) => q.serviceProvider === provider && Number(q.destinationAmount) > 0,
  );
  return { r, line: lines[0] ?? null };
}

/**
 * A BUY session with the body `MeldClient.createWidgetSession` sends, field for field. Where Meld
 * reads `clientIpAddress` for a widget session is not documented anywhere this was written from;
 * it is sent in `sessionData`, beside the fields it describes.
 */
function openSession({ provider, country, fiat, method, amount, reference }) {
  return meld('/crypto/session/widget', {
    method: 'POST',
    body: {
      sessionType: 'BUY',
      sessionData: {
        serviceProvider: provider,
        destinationCurrencyCode: CRYPTO,
        walletAddress: WALLET,
        sourceAmount: amount.toFixed(2),
        sourceCurrencyCode: fiat,
        countryCode: country,
        paymentMethodType: method,
        lockFields: [
          'cryptoCurrency',
          'destinationCurrencyCode',
          'walletAddress',
          'sourceAmount',
          'sourceCurrencyCode',
          'paymentMethodType',
        ],
        externalCustomerId: reference,
        redirectUrl: REDIRECT,
        clientIpAddress: CLIENT_IP,
      },
      externalSessionId: reference,
    },
  });
}

const listOf = (json) => (Array.isArray(json) ? json : (json?.transactions ?? (json?.transaction ? [json.transaction] : [])));

/** The transaction behind a session: by the reference, as the worker finds a buy's, and by
 *  Meld's session id, the per-session path (read for a sell) and the `sessionIds` filter. */
async function lookups(reference, sessionId) {
  const [byReference, bySession, bySessionIds] = await Promise.all([
    meld(`/payments/transactions?externalSessionIds=${encodeURIComponent(reference)}`),
    meld(`/payments/transactions/sessions/${encodeURIComponent(sessionId)}`),
    meld(`/payments/transactions?sessionIds=${encodeURIComponent(sessionId)}`),
  ]);
  const read = (r) => (r.ok ? listOf(r.json) : []);
  return { reference: read(byReference), session: read(bySession), sessionIds: read(bySessionIds) };
}

// --- what the worker records -----------------------------------------------------------------

const TERMINAL = new Set(['SETTLED', 'COMPLETED', 'FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'AUTHORIZATION_EXPIRED', 'VOIDED', 'EXPIRED']);

/** The funding state `MELD_STATUS_TO_STATE` (src/meld/rail.ts) maps a status to, with the raw
 *  status the record keeps as `provider_status`. No transaction leaves the row where it was. */
function workerState(status) {
  const s = status.toUpperCase();
  if (!s) return 'no transaction (row unchanged)';
  if (['SETTLED', 'COMPLETED', 'SUCCESS', 'SUCCEEDED'].includes(s)) return `settled (${s})`;
  if (['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'AUTHORIZATION_EXPIRED'].includes(s)) return `failed (${s})`;
  return `transaction_seen (${s})`;
}

/** The fields worth following: every status-like one, by path, so a provider's own status
 *  shows too, and Meld's own timestamps. */
function fieldsOf(tx, path = '', out = {}) {
  if (tx === null || typeof tx !== 'object') return out;
  for (const [k, v] of Object.entries(tx)) {
    const p = path ? `${path}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) fieldsOf(v, p, out);
    else if (/status|state|reason/i.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) out[p] = v;
    else if (path === '' && (k === 'createdAt' || k === 'updatedAt')) out[p] = v;
  }
  return out;
}

// --- notes typed while a case is watched ------------------------------------------------------

const input = process.stdin.isTTY || has('stdin') ? createInterface({ input: process.stdin }) : null;
const typed = [];
input?.on('line', (line) => typed.push(line.trim()));
async function ask(question) {
  if (!process.stdin.isTTY) return '';
  process.stdout.write(question);
  typed.length = 0;
  while (typed.length === 0) await sleep(200);
  return typed.shift() ?? '';
}

const secondsSince = (t0) => Math.round((Date.now() - t0) / 1000);

// --- one watched case ------------------------------------------------------------------------

async function prepare(c) {
  const defaults = await meld(`/network-partner/defaults/${c.country}/CRYPTO_ONRAMP`);
  const fiat = defaults.json?.currencyCode ?? 'USD';
  const route = await routeFor({ ...c, fiat });
  return { fiat, route, amount: amountFor(route, fiat) };
}

async function watchCase(c) {
  const p = await prepare(c);
  const result = { ...c, fiat: p.fiat, amount: p.amount, session: null, attempts: [], events: [], final: '', redirect: '', notes: [] };
  if (!p.route) result.notes.push(`${c.provider} lists no ${c.method} route for ${CRYPTO} in ${c.country} on this account`);
  console.log(`\n=== ${c.provider} ${c.method} in ${c.country}, ${String(p.amount)} ${p.fiat} for ${CRYPTO}`);

  const q = await quote({ ...c, ...p });
  console.log(q.line ? `quote: ${q.line.destinationAmount} ${CRYPTO} for ${q.line.sourceAmount} ${p.fiat}` : `quote: none (${why(q.r)})`);

  const reference = `meld-statuses-${c.provider.toLowerCase()}-${c.method.toLowerCase()}-${c.country.toLowerCase()}-${String(Date.now())}`;
  let session = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const r = await openSession({ ...c, ...p, reference });
    result.attempts.push(r.ok ? 'opened' : why(r));
    record({ case: c, reference, step: 'session', attempt, ok: r.ok, status: r.status, body: r.json ?? r.text });
    if (r.ok) {
      session = r.json;
      break;
    }
    console.log(`session refused (try ${String(attempt + 1)}): ${why(r)}`);
    if (attempt < RETRIES) await sleep(2000);
  }
  if (!session) {
    result.final = 'session refused';
    return result;
  }
  result.session = session.id;
  const url = session.widgetUrl ?? session.serviceProviderWidgetUrl;
  console.log(`session ${session.id}${result.attempts.length > 1 ? ` (opened on try ${String(result.attempts.length)})` : ''}`);
  console.log(`widget: ${url}`);
  if (OPEN && url) execFile('open', [url], () => undefined);
  console.log('Pay with the sandbox test details. A note and Enter marks a moment; n and Enter moves on.');

  const t0 = Date.now();
  const add = (event) => {
    const e = { t: secondsSince(t0), ...event };
    result.events.push(e);
    return e;
  };
  add({ kind: 'opened' });
  let last = '';
  let terminalAt = null;
  typed.length = 0;
  for (;;) {
    if (Date.now() - t0 > WATCH_MS) break;
    if (terminalAt !== null && Date.now() - terminalAt > LINGER_MS) break;
    let next = false;
    while (typed.length) {
      const line = typed.shift() ?? '';
      if (/^(n|next)$/i.test(line)) next = true;
      else console.log(`  ${String(add({ kind: 'mark', text: line || 'mark' }).t).padStart(4)}s  >> ${line || 'mark'}`);
    }
    if (next) {
      result.notes.push('moved on by the tester');
      break;
    }
    await sleep(INTERVAL_MS);
    const seen = await lookups(reference, session.id);
    const byReference = seen.reference[0];
    const other = seen.session[0] ?? seen.sessionIds[0];
    const fields = fieldsOf(byReference ?? other ?? {});
    // A change is a change in what the lookups return, not Meld touching `updatedAt`.
    const compared = { ...fields };
    delete compared.updatedAt;
    const snapshot = JSON.stringify({
      reference: byReference?.status ?? null,
      other: other?.status ?? null,
      count: seen.reference.length,
      compared,
    });
    if (snapshot === last) continue;
    last = snapshot;
    const status = byReference?.status ?? '';
    const missed = !byReference && Boolean(other);
    const e = add({ kind: 'status', status, other: other?.status ?? '', missed, fields, worker: workerState(status) });
    record({ case: c, reference, session: session.id, step: 'poll', t: e.t, seen });
    const extra = Object.entries(fields)
      .filter(([k]) => k !== 'status')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    const shown = status || (missed ? `(not by reference; by session: ${String(other?.status)})` : '(no transaction)');
    console.log(`  ${String(e.t).padStart(4)}s  ${shown}${extra ? `  [${extra}]` : ''}  -> worker: ${e.worker}`);
    if (missed && !result.notes.includes('transaction not found by reference')) {
      result.notes.push('transaction not found by reference');
      console.log("        !! Meld has a transaction for this session that the worker's lookup does not return");
    }
    result.final = status || (other?.status ? `${other.status}*` : result.final);
    if (TERMINAL.has((byReference?.status ?? other?.status ?? '').toUpperCase()) && terminalAt === null) terminalAt = Date.now();
  }
  const redirect = await ask('Did the widget send you to the redirect page? [y/n, Enter to skip] ');
  result.redirect = /^y/i.test(redirect) ? 'yes' : /^n/i.test(redirect) ? 'no' : '';
  const note = await ask('Anything to note for this case (Enter for nothing)? ');
  if (note) result.notes.push(note);
  return result;
}

// --- sessions only ---------------------------------------------------------------------------

async function sessionsCase(c) {
  const p = await prepare(c);
  const out = { ...c, fiat: p.fiat, amount: p.amount, outcomes: [] };
  console.log(`\n=== ${c.provider} ${c.method} in ${c.country}: ${String(SESSIONS)} sessions`);
  for (let i = 0; i < SESSIONS; i++) {
    const reference = `meld-statuses-probe-${c.provider.toLowerCase()}-${c.country.toLowerCase()}-${String(Date.now())}-${String(i)}`;
    const r = await openSession({ ...c, ...p, reference });
    out.outcomes.push(r.ok ? 'opened' : why(r));
    record({ case: c, reference, step: 'session-probe', ok: r.ok, status: r.status, body: r.json ?? r.text });
    console.log(`  ${String(i + 1)}: ${r.ok ? 'opened' : why(r)}`);
    await sleep(1500);
  }
  return out;
}

// --- reports ---------------------------------------------------------------------------------

const label = (e) => e.status || (e.other ? `${e.other}*` : '');

function summaryRow(r) {
  const name = `${r.provider} ${r.method} ${r.country}`;
  if (!r.session) return `| ${name} | session refused ${String(r.attempts.length)}×: ${r.attempts.at(-1) ?? ''} | | | | | | ${r.notes.join('; ')} |`;
  const statuses = r.events.filter((e) => e.kind === 'status');
  const first = statuses.find((e) => label(e));
  const mark = r.events.find((e) => e.kind === 'mark');
  const afterMark = mark && statuses.find((e) => e.t >= mark.t && label(e));
  const settling = statuses.find((e) => /SETTLING/i.test(label(e)));
  const terminal = statuses.find((e) => TERMINAL.has(label(e).replace('*', '').toUpperCase()));
  const sequence = statuses
    .map(label)
    .filter((s, i, a) => s && s !== a[i - 1])
    .join(' → ');
  const at = (e) => (e ? `${String(e.t)}s` : 'never');
  const tries = r.attempts.length > 1 ? ` (opened on try ${String(r.attempts.length)})` : '';
  const markCell = mark ? `${mark.text} at ${String(mark.t)}s → ${afterMark ? `${label(afterMark)} at ${String(afterMark.t)}s` : 'no change after it'}` : '';
  return `| ${name}${tries} | ${sequence || 'none'} | ${at(first)} | ${markCell} | ${settling ? `yes, ${String(settling.t)}s` : 'no'} | ${at(terminal)} | ${r.redirect} | ${r.notes.join('; ')} |`;
}

function timeline(r) {
  const lines = [`### ${r.provider} ${r.method} in ${r.country}, ${String(r.amount)} ${r.fiat}`, ''];
  if (!r.session) {
    lines.push(`Session refused on every try: ${r.attempts.join(' | ')}`, '');
    return lines.join('\n');
  }
  lines.push(
    '| Seconds | By reference | By session id | Fields | Worker records | Tester |',
    '|---|---|---|---|---|---|',
  );
  for (const e of r.events) {
    if (e.kind === 'mark') lines.push(`| ${String(e.t)} | | | | | ${e.text} |`);
    else if (e.kind === 'opened') lines.push(`| ${String(e.t)} | session opened | | | | |`);
    else {
      const fields = Object.entries(e.fields)
        .filter(([k]) => k !== 'status')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
      lines.push(`| ${String(e.t)} | ${e.status || 'none'} | ${e.other || 'none'}${e.missed ? ' (not by reference)' : ''} | ${fields} | ${e.worker} | |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

const watchedReport = (results) =>
  [
    `# Meld statuses per provider, ${ENV}, ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Buying ${CRYPTO}, sessions opened as createWidgetSession opens them, polled every ${String(INTERVAL_MS / 1000)} s. The worker polls every \`worker.interval_ms\` (15 s by default) and by the reference only, so it records each status up to that much later, and never one marked *.`,
    '',
    '| Case | Statuses in order (* not by reference) | First transaction | First note → next status | SETTLING | Terminal | Redirect honoured | Notes |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(summaryRow),
    '',
    '## Timelines',
    '',
    ...results.map(timeline),
  ].join('\n');

function sessionsReport(results) {
  const rows = results.map((r) => {
    const opened = r.outcomes.filter((o) => o === 'opened').length;
    const refusals = [...new Set(r.outcomes.filter((o) => o !== 'opened'))];
    // A refusal followed by an opened session within two tries: what a retry would have bought.
    const recovered = r.outcomes.some((o, i) => o !== 'opened' && r.outcomes.slice(i + 1, i + 3).includes('opened'));
    const marks = r.outcomes.map((o) => (o === 'opened' ? '✓' : '✗')).join('');
    return `| ${r.provider} ${r.method} ${r.country} | ${String(r.amount)} ${r.fiat} | ${String(opened)}/${String(r.outcomes.length)} | ${refusals.join(' / ')} | ${refusals.length ? (recovered ? 'yes' : 'no') : ''} | ${marks} |`;
  });
  return [
    `# Meld session refusals, ${ENV}, ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${String(SESSIONS)} sessions per case, opened as createWidgetSession opens them, 1.5 s apart, none paid.`,
    '',
    '| Case | Amount | Opened | Refusals | A refusal then an opened session within two tries | In order |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// --- run -------------------------------------------------------------------------------------

const results = [];
const save = () => {
  writeFileSync(join(OUT, 'statuses.json'), JSON.stringify(results, null, 2));
  writeFileSync(join(OUT, 'statuses.md'), SESSIONS ? sessionsReport(results) : watchedReport(results));
};
process.on('SIGINT', () => {
  save();
  console.log(`\nStopped. What was seen so far is in ${OUT}`);
  process.exit(130);
});

console.log(`Meld ${ENV} (${BASE}), ${String(CASES.length)} cases${SESSIONS ? `, ${String(SESSIONS)} sessions each, unwatched` : ''}; out ${OUT}`);
for (const c of CASES) {
  results.push(SESSIONS ? await sessionsCase(c) : await watchCase(c));
  save();
}
input?.close();
console.log(`\nSaved in ${join(OUT, 'statuses.md')}`);
